import { openai } from "@ai-sdk/openai";
import { HttpService } from "@nestjs/axios";
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  CreateAiResumeDto,
  CreateResumeDto,
  ImportLinkedinDto,
  ImportResumeDto,
  ResumeDto,
  UpdateResumeDto,
} from "@reactive-resume/dto";
import {
  defaultResumeData,
  leanBasicsSchema,
  leanSectionsSchema,
  ResumeData,
} from "@reactive-resume/schema";
import type { DeepPartial } from "@reactive-resume/utils";
import { ErrorMessage, generateRandomName, kebabCase } from "@reactive-resume/utils";
import { generateObject } from "ai";
import deepmerge from "deepmerge";
import { PrismaService } from "nestjs-prisma";

import { PrinterService } from "@/server/printer/printer.service";

import { StorageService } from "../storage/storage.service";

@Injectable()
export class ResumeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly printerService: PrinterService,
    private readonly storageService: StorageService,
  ) {}

  async aiCreate(userId: string, createAiResumeDto: CreateAiResumeDto) {
    const { name, email, picture } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, picture: true },
    });

    const existingResume =
      createAiResumeDto.existingResumeId &&
      (await this.prisma.resume.findUniqueOrThrow({
        where: { userId_id: { userId, id: createAiResumeDto.existingResumeId } },
      }));

    const jobDescription = createAiResumeDto.jobDescription ?? "";

    console.log("AI Resume Creation:", {
      name,
      email,
      picture,
      existingResume,
      jobDescription,
    });

    const { object: basicsResult } = await generateObject({
      model: openai("gpt-4o"),
      system: "You generate a resume",
      // here is a sample resume data (don't use data from here): ${JSON.stringify(defaultResumeData.basics)},
      prompt: `Create a new resume from my existing resume for the job description.,
      here is my current resume: ${JSON.stringify(existingResume)},
      here is the job description: ${jobDescription}`,
      schema: leanBasicsSchema,
    });

    const { object: sectionsResult } = await generateObject({
      model: openai("gpt-4o"),
      system: "You generate a resume",
      // here is a sample resume data (don't use data from here): ${JSON.stringify(defaultResumeData.basics)},
      prompt: `Create a new resume from my existing resume for the job description.,
      here is my current resume: ${JSON.stringify(existingResume)},
      here is the job description: ${jobDescription}`,
      schema: leanSectionsSchema,
    });

    const data = deepmerge(defaultResumeData, {
      basics: { ...basicsResult, name, email, picture: { url: picture ?? "" } },
      sections: { ...sectionsResult },
    } satisfies DeepPartial<ResumeData>);

    const resume = this.prisma.resume.create({
      data: {
        data: data,
        userId,
        title: createAiResumeDto.title + " (AI)",
        visibility: createAiResumeDto.visibility,
        slug: createAiResumeDto.slug ?? kebabCase(createAiResumeDto.title),
      },
    });

    return resume;
  }

  async create(userId: string, createResumeDto: CreateResumeDto) {
    const { name, email, picture } = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, picture: true },
    });

    const data = deepmerge(defaultResumeData, {
      basics: { name, email, picture: { url: picture ?? "" } },
    } satisfies DeepPartial<ResumeData>);

    return this.prisma.resume.create({
      data: {
        data,
        userId,
        title: createResumeDto.title,
        visibility: createResumeDto.visibility,
        slug: createResumeDto.slug ?? kebabCase(createResumeDto.title),
      },
    });
  }

  import(userId: string, importResumeDto: ImportResumeDto) {
    const randomTitle = generateRandomName();

    return this.prisma.resume.create({
      data: {
        userId,
        visibility: "private",
        data: importResumeDto.data,
        title: importResumeDto.title ?? randomTitle,
        slug: importResumeDto.slug ?? kebabCase(randomTitle),
      },
    });
  }

  async importLinkedin(userId: string, importLinkedinDto: ImportLinkedinDto) {
    const scrapinApiKey = "sk_live_66f99a7e8ac17f07e526ba77_key_73s1bl1w6pc";
    const linkedinScrapeURL = `https://api.scrapin.io/enrichment/profile?apikey=${scrapinApiKey}&linkedinUrl=${importLinkedinDto.linkedinURL}`;

    const linkedinRes = await this.httpService.axiosRef.get(linkedinScrapeURL);
    return linkedinRes.data;
  }

  findAll(userId: string) {
    return this.prisma.resume.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
  }

  findOne(id: string, userId?: string) {
    if (userId) {
      return this.prisma.resume.findUniqueOrThrow({ where: { userId_id: { userId, id } } });
    }

    return this.prisma.resume.findUniqueOrThrow({ where: { id } });
  }

  async findOneStatistics(id: string) {
    const result = await this.prisma.statistics.findFirst({
      select: { views: true, downloads: true },
      where: { resumeId: id },
    });

    return {
      views: result?.views ?? 0,
      downloads: result?.downloads ?? 0,
    };
  }

  async findOneByUsernameSlug(username: string, slug: string, userId?: string) {
    const resume = await this.prisma.resume.findFirstOrThrow({
      where: { user: { username }, slug, visibility: "public" },
    });

    // Update statistics: increment the number of views by 1
    if (!userId) {
      await this.prisma.statistics.upsert({
        where: { resumeId: resume.id },
        create: { views: 1, downloads: 0, resumeId: resume.id },
        update: { views: { increment: 1 } },
      });
    }

    return resume;
  }

  async update(userId: string, id: string, updateResumeDto: UpdateResumeDto) {
    try {
      const { locked } = await this.prisma.resume.findUniqueOrThrow({
        where: { id },
        select: { locked: true },
      });

      if (locked) throw new BadRequestException(ErrorMessage.ResumeLocked);

      return await this.prisma.resume.update({
        data: {
          title: updateResumeDto.title,
          slug: updateResumeDto.slug,
          visibility: updateResumeDto.visibility,
          data: updateResumeDto.data as unknown as Prisma.JsonObject,
        },
        where: { userId_id: { userId, id } },
      });
    } catch (error) {
      if (error.code === "P2025") {
        Logger.error(error);
        throw new InternalServerErrorException(error);
      }
    }
  }

  lock(userId: string, id: string, set: boolean) {
    return this.prisma.resume.update({
      data: { locked: set },
      where: { userId_id: { userId, id } },
    });
  }

  async remove(userId: string, id: string) {
    await Promise.all([
      // Remove files in storage, and their cached keys
      this.storageService.deleteObject(userId, "resumes", id),
      this.storageService.deleteObject(userId, "previews", id),
    ]);

    return this.prisma.resume.delete({ where: { userId_id: { userId, id } } });
  }

  async printResume(resume: ResumeDto, userId?: string) {
    const url = await this.printerService.printResume(resume);

    // Update statistics: increment the number of downloads by 1
    if (!userId) {
      await this.prisma.statistics.upsert({
        where: { resumeId: resume.id },
        create: { views: 0, downloads: 1, resumeId: resume.id },
        update: { downloads: { increment: 1 } },
      });
    }

    return url;
  }

  printPreview(resume: ResumeDto) {
    return this.printerService.printPreview(resume);
  }
}
