import * as dotenv from "dotenv";
dotenv.config();

import { readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Message } from "wechaty";
import type { ContactInterface, RoomInterface } from "wechaty/impls";

// ============================================================
// 配置
// ============================================================

export const envConfig = {
  llm: {
    baseUrl: process.env.OPENAI_API_BASE_URL || "",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.LLM_MODEL || "gpt-3.5-turbo",
    temperature: process.env.TEMPERATURE ? parseFloat(process.env.TEMPERATURE) : 0.6,
  },
  wechat: {
    chatPrivateTriggerKeyword: process.env.CHAT_PRIVATE_TRIGGER_KEYWORD || "",
    chatTriggerRule: process.env.CHAT_TRIGGER_RULE || "",
    disableGroupMessage: process.env.DISABLE_GROUP_MESSAGE === "true",
    blockWords: process.env.BLOCK_WORDS?.split(",").filter(Boolean) || [],
    chatgptBlockWords: process.env.CHATGPT_BLOCK_WORDS?.split(",").filter(Boolean) || [],
  },
} as const;

// ============================================================
// 工具函数
// ============================================================

/** 转义正则特殊字符 */
export const regexpEncode = (str: string) =>
  str.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

// ============================================================
// 类型定义
// ============================================================

export enum MessageType {
  Unknown = 0,
  Attachment = 1,
  Audio = 2,
  Contact = 3,
  ChatHistory = 4,
  Emoticon = 5,
  Image = 6,
  Text = 7,
  Location = 8,
  MiniProgram = 9,
  GroupNote = 10,
  Transfer = 11,
  RedEnvelope = 12,
  Recalled = 13,
  Url = 14,
  Video = 15,
  Post = 16,
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BotSession {
  sessionId: string;
  chatHistory: ChatMessage[];
  meta: Record<string, unknown>;
}

export interface BotContext {
  talker: ContactInterface;
  room: RoomInterface | undefined;
  rawMessage: Message;
  messageType: MessageType;
  content: string;
  attachments: Array<{ type: "image" | "file"; mimeType: string; data: string }>;
  isRoom: boolean;
  session: BotSession;
  reply: string | undefined;
}

// ============================================================
// 插件抽象基类
// ============================================================

export abstract class BasePlugin {
  abstract name: string;
  abstract version: string;
  abstract priority: number;
  abstract onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void>;
}

// ============================================================
// 会话管理器
// ============================================================

const sessionStore = new Map<string, BotSession>();

export function getOrCreateSession(sessionId: string): BotSession {
  let session = sessionStore.get(sessionId);
  if (!session) {
    session = { sessionId, chatHistory: [], meta: {} };
    sessionStore.set(sessionId, session);
  }
  return session;
}

export function clearSession(sessionId: string): void {
  const session = sessionStore.get(sessionId);
  if (session) {
    session.chatHistory = [];
    session.meta = {};
  }
}

// ============================================================
// 插件管理器
// ============================================================

export class PluginManager {
  private plugins: BasePlugin[] = [];

  /** 注册插件，自动按 priority 排序 */
  register(plugin: BasePlugin): void {
    this.plugins.push(plugin);
    this.plugins.sort((a, b) => a.priority - b.priority);
    console.log(
      `[PluginManager] 已注册插件: ${plugin.name} v${plugin.version} (priority: ${plugin.priority})`
    );
  }

  /** 自动扫描 src/plugins/ 目录并动态加载所有插件 */
  async loadPlugins(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pluginsDir = resolve(__dirname, "plugins");

    let files: string[];
    try {
      files = readdirSync(pluginsDir).filter(
        (f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts")
      );
    } catch {
      console.warn("[PluginManager] plugins 目录不存在或不可读");
      return;
    }

    for (const file of files) {
      const filePath = resolve(pluginsDir, file);
      const fileUrl = pathToFileURL(filePath).href;
      try {
        const module = await import(fileUrl);
        for (const key of Object.keys(module)) {
          const exported = module[key];
          if (
            typeof exported === "function" &&
            exported.prototype instanceof BasePlugin
          ) {
            const instance: BasePlugin = new exported();
            this.register(instance);
          }
        }
      } catch (err) {
        console.error(`[PluginManager] 加载插件失败: ${file}`, err);
      }
    }
  }

  /** 组装洋葱模型并依次执行所有插件 */
  async execute(ctx: BotContext): Promise<void> {
    const dispatch = (index: number): Promise<void> => {
      if (index >= this.plugins.length) return Promise.resolve();
      return this.plugins[index].onMessage(ctx, () => dispatch(index + 1));
    };
    await dispatch(0);
    if (ctx.reply !== undefined) {
      await ctx.rawMessage.say(ctx.reply);
    }
  }

  /** 列出所有已注册插件 */
  listPlugins(): ReadonlyArray<BasePlugin> {
    return this.plugins;
  }
}

export const pluginManager = new PluginManager();

// ============================================================
// 核心消息路由器
// ============================================================

export class ChatGPTBot {
  private botName: string = "";

  setBotName(botName: string) {
    this.botName = botName;
  }

  get chatGroupTriggerRegEx(): RegExp {
    return new RegExp(`^@${regexpEncode(this.botName)}`);
  }

  /** 清理触发词和引用消息 */
  cleanMessage(rawText: string, privateChat: boolean = false): string {
    let text = rawText;
    const item = rawText.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      text = item[item.length - 1];
    }

    const chatTriggerRule = envConfig.wechat.chatTriggerRule
      ? new RegExp(envConfig.wechat.chatTriggerRule)
      : undefined;

    if (privateChat) {
      const keyword = envConfig.wechat.chatPrivateTriggerKeyword;
      const regEx =
        chatTriggerRule || (keyword ? new RegExp(regexpEncode(keyword)) : undefined);
      if (regEx) text = text.replace(regEx, "");
    } else {
      // 群聊的 @提及 已在 onMessage 中通过 mentionText() 剥离
      if (chatTriggerRule) text = text.replace(chatTriggerRule, "");
    }
    return text;
  }

  /** 基础过滤 */
  isNonsense(talker: ContactInterface, messageType: number, text: string): boolean {
    return (
      talker.self() ||
      !(messageType === MessageType.Text || messageType === MessageType.Audio || messageType === MessageType.Image) ||
      talker.name() === "微信团队" ||
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      text.includes("收到红包，请在手机上查看") ||
      text.includes("收到转账，请在手机上查看") ||
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg") ||
      this.checkBlockWords(text)
    );
  }

  private checkBlockWords(message: string): boolean {
    const blockWords = envConfig.wechat.blockWords as readonly string[];
    if (blockWords.length === 0) return false;
    return blockWords.some((word) => message.includes(word));
  }

  /** 核心入口：过滤 → 包装上下文 → 插件管道 */
  async onMessage(message: Message) {
    const talker = message.talker();
    const rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const isRoom = !!room;

    if (isRoom) {
      const topic = await room!.topic();
      console.log(`[Room] ${topic} | [Contact] ${talker.name()} | [Text] ${rawText}`);
    } else {
      console.log(`[Contact] ${talker.name()} | [Text] ${rawText}`);
    }

    if (this.isNonsense(talker, messageType, rawText)) return;

    // 群聊必须 @机器人 才触发（图片消息例外，因为纯图片无法携带 @提及）
    if (isRoom && messageType !== MessageType.Image && !(await message.mentionSelf())) return;

    // 群聊：使用 mentionText() 剥离 @提及，私聊：使用原始文本
    const textForContent = isRoom ? (await message.mentionText()).trim() : rawText;

    const sessionId = isRoom ? room!.id : talker.id;
    const session = getOrCreateSession(sessionId);

    const ctx: BotContext = {
      talker,
      room: room ?? undefined,
      rawMessage: message,
      messageType: messageType as MessageType,
      content: messageType === MessageType.Image ? "" : this.cleanMessage(textForContent, !isRoom),
      attachments: [],
      isRoom,
      session,
      reply: undefined,
    };

    await pluginManager.execute(ctx);
  }
}