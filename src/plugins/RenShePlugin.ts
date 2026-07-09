import { MessageType } from "../core.js";
import type { BotContext, ChatMessage } from "../core.js";
import { AbstractHotReloadPlugin } from "../core/AbstractHotReloadPlugin.js";
import { existsSync, readFileSync, readdirSync } from "fs";
import { readdir } from "fs/promises";
import { resolve } from "path";
import { inflateSync } from "zlib";

interface CardData {
  id: string;
  name: string;
  system_prompt: string;
  first_mes: string;
  world_info?: string;
}

interface RenSheConfig {
  help_template: string;
  switch_success_template: string;
  switch_fail_template: string;
  system_prompt_base_template: string;
}

const DEFAULT_RENSHE_CONFIG: RenSheConfig = {
  help_template: "Available character cards: {{cards_list}}. Use /switch [ID] to switch.",
  switch_success_template: "Switched to: {{character_name}}.\n\n{{first_message}}",
  switch_fail_template: "Switch failed: Character [{{target_id}}] not found. Use /switch to list all cards.",
  system_prompt_base_template: "{{system_prompt}}",
};

/**
 * 人设切换插件（纯净化配置驱动版 + 内存缓存架构）
 * 所有文本、提示词模板均由外部 configs/renshe.json 配置文件管理
 * 角色卡数据全量预加载到内存，通过 fs.watch 实现热重载
 * 核心代码只负责逻辑流转，不包含任何硬编码文本
 * 不自动创建任何文件，所有角色卡由用户手动提供
 */
export class RenShePlugin extends AbstractHotReloadPlugin<RenSheConfig> {
  name = "renshe";
  version = "2.2.0";
  priority = 5;

  private cardsDir = resolve(process.cwd(), "cards");
  private cardCache: Map<string, CardData> = new Map();
  private availableCardsCache: string[] = [];

  constructor() {
    super("renshe.json", DEFAULT_RENSHE_CONFIG);
    this.initializeCardCache();
    this.startCardsDirectoryWatcher();
  }

  /**
   * 初始化角色卡缓存（预加载所有角色卡到内存）
   */
  private initializeCardCache(): void {
    try {
      if (!existsSync(this.cardsDir)) {
        console.warn("[RenShePlugin] cards 目录不存在");
        return;
      }

      const files = readdirSync(this.cardsDir);
      const ids = new Set<string>();

      for (const file of files) {
        if (file.endsWith(".json")) {
          const id = file.replace(/\.json$/, "");
          ids.add(id);
          this.loadCardIntoCache(id);
        } else if (file.endsWith(".png")) {
          const id = file.replace(/\.png$/, "");
          ids.add(id);
          this.loadCardIntoCache(id);
        }
      }

      this.availableCardsCache = Array.from(ids).sort();
      console.log(`[RenShePlugin] 已预加载 ${this.cardCache.size} 张角色卡到内存`);
    } catch (error) {
      console.error("[RenShePlugin] 角色卡缓存初始化失败:", error);
    }
  }

  /**
   * 加载单个角色卡到缓存
   */
  private loadCardIntoCache(targetId: string): void {
    const card = this.resolveCardDataFromDisk(targetId);
    if (card) {
      this.cardCache.set(targetId, card);
    }
  }

  /**
   * 启动角色卡目录监听器（基于基类 startDirectoryWatcher）
   */
  private startCardsDirectoryWatcher(): void {
    if (!existsSync(this.cardsDir)) {
      console.warn("[RenShePlugin] cards 目录不存在，跳过监听器启动");
      return;
    }

    this.startDirectoryWatcher(this.cardsDir, async () => {
      const files = await readdir(this.cardsDir);
      const ids = new Set<string>();
      const newCache = new Map<string, CardData>();

      for (const file of files) {
        let id: string | null = null;
        if (file.endsWith(".json")) {
          id = file.replace(/\.json$/, "");
        } else if (file.endsWith(".png")) {
          id = file.replace(/\.png$/, "");
        }

        if (id) {
          ids.add(id);
          const card = this.resolveCardDataFromDisk(id);
          if (card) {
            newCache.set(id, card);
          }
        }
      }

      this.cardCache = newCache;
      this.availableCardsCache = Array.from(ids).sort();
      console.log(`[renshe] 角色卡缓存已热重载，当前 ${this.cardCache.size} 张`);
    });
  }

  /**
   * 模板渲染引擎（将 {{key}} 替换为对应变量值）
   */
  private renderTemplate(template: string, variables: Record<string, any>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      // 安全处理：undefined/null 替换为空字符串
      const replacement = value !== undefined && value !== null ? String(value) : "";
      result = result.split(placeholder).join(replacement);
    }
    return result;
  }

  /**
   * 从 PNG 图片中提取酒馆角色卡数据
   * 支持 tEXt、zTXt、iTXt 三种 Chunk 类型
   * 自动处理 zlib 压缩数据
   */
  private extractPngCharaText(pngPath: string): any | null {
    try {
      const buffer = readFileSync(pngPath);

      // 验证 PNG 签名（前 8 字节）
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!buffer.subarray(0, 8).equals(pngSignature)) {
        console.warn("[RenShePlugin] 非标准 PNG 文件:", pngPath);
        return null;
      }

      let offset = 8;

      // 逐 Chunk 遍历
      while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;

        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        offset += 8;

        if (offset + length > buffer.length) break;

        const chunkData = buffer.subarray(offset, offset + length);
        offset += length + 4; // 跳过 CRC

        // 处理 tEXt Chunk（未压缩文本）
        if (type === "tEXt") {
          const nullIndex = chunkData.indexOf(0);
          if (nullIndex === -1) continue;

          const keyword = chunkData.toString("latin1", 0, nullIndex);
          if (keyword.toLowerCase() === "chara") {
            const textData = chunkData.toString("utf-8", nullIndex + 1);
            try {
              // 尝试 Base64 解码
              const decoded = Buffer.from(textData, "base64").toString("utf-8");
              return JSON.parse(decoded);
            } catch {
              // 直接解析 JSON
              return JSON.parse(textData);
            }
          }
        }

        // 处理 zTXt Chunk（zlib 压缩文本）
        if (type === "zTXt") {
          const nullIndex = chunkData.indexOf(0);
          if (nullIndex === -1) continue;

          const keyword = chunkData.toString("latin1", 0, nullIndex);
          if (keyword.toLowerCase() === "chara") {
            const compressionMethod = chunkData[nullIndex + 1];
            if (compressionMethod !== 0) continue; // 仅支持 zlib

            const compressedData = chunkData.subarray(nullIndex + 2);
            try {
              const decompressed = inflateSync(Uint8Array.from(compressedData));
              const textData = decompressed.toString("utf-8");
              try {
                // 尝试 Base64 解码
                const decoded = Buffer.from(textData, "base64").toString("utf-8");
                return JSON.parse(decoded);
              } catch {
                // 直接解析 JSON
                return JSON.parse(textData);
              }
            } catch (error) {
              console.error("[RenShePlugin] zlib 解压失败:", error);
              continue;
            }
          }
        }

        // 处理 iTXt Chunk（国际化文本，可选压缩）
        if (type === "iTXt") {
          const nullIndex = chunkData.indexOf(0);
          if (nullIndex === -1) continue;

          const keyword = chunkData.toString("latin1", 0, nullIndex);
          if (keyword.toLowerCase() === "chara") {
            const compressionFlag = chunkData[nullIndex + 1];
            const compressionMethod = chunkData[nullIndex + 2];

            let textStart = nullIndex + 3;
            // 跳过语言标签和翻译关键字（两个 null 终止字符串）
            const langNullIndex = chunkData.indexOf(0, textStart);
            if (langNullIndex !== -1) {
              const transNullIndex = chunkData.indexOf(0, langNullIndex + 1);
              if (transNullIndex !== -1) {
                textStart = transNullIndex + 1;
              }
            }

            const textData = chunkData.subarray(textStart);

            try {
              let decodedText: string;
              if (compressionFlag === 1 && compressionMethod === 0) {
                // 压缩数据，使用 zlib 解压
                const decompressed = inflateSync(Uint8Array.from(textData));
                decodedText = decompressed.toString("utf-8");
              } else {
                // 未压缩数据
                decodedText = textData.toString("utf-8");
              }

              try {
                // 尝试 Base64 解码
                const decoded = Buffer.from(decodedText, "base64").toString("utf-8");
                return JSON.parse(decoded);
              } catch {
                // 直接解析 JSON
                return JSON.parse(decodedText);
              }
            } catch (error) {
              console.error("[RenShePlugin] iTXt 解析失败:", error);
              continue;
            }
          }
        }

        // IEND Chunk 标志 PNG 结束
        if (type === "IEND") break;
      }

      return null;
    } catch (error) {
      console.error("[RenShePlugin] PNG 解析异常:", pngPath, error);
      return null;
    }
  }

  /**
   * 将酒馆格式角色卡统一映射为标准内部结构
   */
  private normalizeCard(raw: any, targetId: string): CardData {
    return {
      id: raw.id || targetId,
      name: raw.name || targetId,
      system_prompt:
        raw.system_prompt ||
        raw.description ||
        raw.personality ||
        "You are a friendly AI assistant.",
      first_mes: raw.first_mes || "Character loaded successfully.",
      world_info: raw.world_info || undefined,
    };
  }

  /**
   * 从磁盘解析角色卡数据（降级路径）
   * 优先读取 JSON，其次 PNG，未找到返回 null
   */
  private resolveCardDataFromDisk(targetId: string): CardData | null {
    // 1. 尝试读取 JSON 文件
    const jsonPath = resolve(this.cardsDir, `${targetId}.json`);
    if (existsSync(jsonPath)) {
      try {
        const content = readFileSync(jsonPath, "utf-8");
        const raw = JSON.parse(content);
        return this.normalizeCard(raw, targetId);
      } catch (error) {
        console.error(`[RenShePlugin] JSON 解析失败: ${targetId}.json`, error);
      }
    }

    // 2. 尝试读取 PNG 文件
    const pngPath = resolve(this.cardsDir, `${targetId}.png`);
    if (existsSync(pngPath)) {
      const raw = this.extractPngCharaText(pngPath);
      if (raw) {
        return this.normalizeCard(raw, targetId);
      }
    }

    // 3. 返回 null 表示未找到
    return null;
  }

  /**
   * 解析角色卡数据（优先从缓存读取，缓存未命中时降级读盘）
   */
  private resolveCardData(targetId: string): CardData | null {
    // 优先从缓存读取
    if (this.cardCache.has(targetId)) {
      return this.cardCache.get(targetId)!;
    }

    // 缓存未命中，降级读盘
    return this.resolveCardDataFromDisk(targetId);
  }

  /**
   * 解析角色卡数据（带内存兜底）
   */
  private resolveCardDataWithFallback(targetId: string): CardData {
    const card = this.resolveCardData(targetId);
    if (card) return card;

    // 直接返回硬编码内存兜底，不尝试读取文件系统
    console.warn(`[RenShePlugin] 未找到角色卡 ${targetId}，使用内存兜底`);
    return {
      id: "default",
      name: "Assistant",
      system_prompt: "You are a friendly AI assistant.",
      first_mes: "Hello, I am your AI assistant. How can I help you?",
    };
  }

  /**
   * 获取所有可用角色卡 ID 列表（直接从内存缓存读取）
   */
  private listAvailableCards(): string[] {
    return this.availableCardsCache;
  }

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    // 仅处理文本消息
    if (ctx.messageType !== MessageType.Text) {
      await next();
      return;
    }

    const content = ctx.content.trim();

    // ========== 指令拦截 1: /switch（无参数，列出所有角色卡） ==========
    if (content === "/switch") {
      const cards = this.listAvailableCards();
      ctx.reply = this.renderTemplate(this.pluginConfig.help_template, {
        cards_list: cards.length > 0 ? cards.join("、") : "No cards available",
      });
      return; // 完美拦截，不调用 next()
    }

    // ========== 指令拦截 2: /switch xxx（带参数，切换角色） ==========
    if (content.startsWith("/switch ")) {
      const targetId = content.slice("/switch ".length).trim();
      
      // 参数为空
      if (!targetId) {
        ctx.reply = this.renderTemplate(this.pluginConfig.switch_fail_template, {
          target_id: "",
        });
        return;
      }

      // 尝试加载角色卡
      const card = this.resolveCardData(targetId);

      if (!card) {
        // 角色卡不存在
        ctx.reply = this.renderTemplate(this.pluginConfig.switch_fail_template, {
          target_id: targetId,
        });
        return;
      }

      // 切换成功
      ctx.session.meta.currentPersona = card.id;

      // 写入世界书线索（若角色卡包含 world_info 字段）
      if (card.world_info) {
        ctx.session.meta.currentPersonaWorldInfo = card.world_info;
      } else {
        // 清空旧的世界书绑定
        ctx.session.meta.currentPersonaWorldInfo = undefined;
      }

      // 清空当前角色的历史记录
      if (!ctx.session.meta.personaHistories) {
        ctx.session.meta.personaHistories = {};
      }
      (ctx.session.meta.personaHistories as Record<string, ChatMessage[]>)[card.id] = [];

      ctx.reply = this.renderTemplate(this.pluginConfig.switch_success_template, {
        character_name: card.name,
        first_message: card.first_mes,
      });

      console.log(`[RenShePlugin] 用户 ${ctx.session.sessionId} 切换到角色: ${card.id}`);
      return; // 完美拦截，不调用 next()
    }

    // ========== 普通消息：洋葱模型前置 + 后置处理 ==========

    // 读取当前激活的角色
    const currentPersona = (ctx.session.meta.currentPersona as string) || "default";
    const card = this.resolveCardDataWithFallback(currentPersona);

    // 写入系统提示词（使用模板渲染）
    ctx.session.meta.systemPrompt = this.renderTemplate(this.pluginConfig.system_prompt_base_template, {
      system_prompt: card.system_prompt,
    });

    // 写入世界书线索（若角色卡包含 world_info 字段）
    if (card.world_info) {
      ctx.session.meta.currentPersonaWorldInfo = card.world_info;
    }

    // 初始化角色历史隔离空间
    if (!ctx.session.meta.personaHistories) {
      ctx.session.meta.personaHistories = {};
    }
    const personaHistories = ctx.session.meta.personaHistories as Record<string, ChatMessage[]>;

    // 确保当前角色有独立的历史记录数组
    if (!personaHistories[currentPersona]) {
      personaHistories[currentPersona] = [];
    }

    // 覆盖为当前角色的专属历史
    ctx.session.chatHistory = personaHistories[currentPersona];

    console.log(
      `[RenShePlugin] 角色: ${currentPersona} | 历史记录条数: ${ctx.session.chatHistory.length}`
    );

    // 放行消息流向下游（ShiTuPlugin -> ShiJieShuPlugin -> LLMPlugin）
    await next();

    // ========== 洋葱模型后置：保存更新后的历史记录 ==========
    // LLMPlugin 已将新对话追加到 ctx.session.chatHistory
    personaHistories[currentPersona] = ctx.session.chatHistory;

  }
}
