import type { Wechaty } from "wechaty";
import QRCode from "qrcode";
import { ChatGPTBot, pluginManager } from "../core.js";

enum BotStatus {
  STOPPED = "STOPPED",
  STARTING = "STARTING",
  RUNNING = "RUNNING",
}

export class BotController {
  private bot: Wechaty | null = null;
  private status: BotStatus = BotStatus.STOPPED;
  private botFactory: () => Wechaty;
  private chatGPTBot: ChatGPTBot;
  private initializedAt: number = 0;

  public onUIRequestRefresh?: () => void;

  constructor(botFactory: () => Wechaty, chatGPTBot: ChatGPTBot) {
    this.botFactory = botFactory;
    this.chatGPTBot = chatGPTBot;
  }

  getStatus(): string {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.status === BotStatus.RUNNING) {
      console.log("[BotController] 警告: 机器人已在运行中，无需重复启动");
      return;
    }

    if (this.status === BotStatus.STARTING) {
      console.log("[BotController] 警告: 机器人正在启动中，请勿重复操作");
      return;
    }

    try {
      this.status = BotStatus.STARTING;
      this.initializedAt = Date.now();

      this.bot = this.botFactory();

      this.bot
        .on("scan", async (qrcode, status) => {
          const url = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
          console.log(`Scan QR Code to login: ${status}\n${url}`);
          console.log(await QRCode.toString(qrcode, { type: "terminal", small: true }));
        })
        .on("login", async (user) => {
          this.chatGPTBot.setBotName(user.name());
          console.log(`User ${user} logged in`);

          await pluginManager.loadPlugins();
          console.log(`已加载 ${pluginManager.listPlugins().length} 个插件`);
          this.onUIRequestRefresh?.();
        })
        .on("message", async (message) => {
          if (message.date().getTime() < this.initializedAt) return;
          if (message.text().startsWith("/ping")) {
            await message.say("pong");
            return;
          }
          try {
            await this.chatGPTBot.onMessage(message);
          } catch (e) {
            console.error("[BotController] 消息处理异常:", e);
          }
        });

      await this.bot.start();
      this.status = BotStatus.RUNNING;
      console.log("[BotController] 机器人启动成功");
    } catch (e) {
      console.error("[BotController] 启动失败:", e);
      this.status = BotStatus.STOPPED;
      this.bot = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.status === BotStatus.STOPPED) {
      console.log("[BotController] 警告: 机器人已停止，无需重复操作");
      return;
    }

    try {
      if (this.bot) {
        await this.bot.stop();
        this.bot = null;
      }
      this.status = BotStatus.STOPPED;
      console.log("[BotController] 机器人已停止");
    } catch (e) {
      console.error("[BotController] 停止失败:", e);
      throw e;
    }
  }

  async relogin(): Promise<void> {
    console.log("[BotController] 开始重新登入微信...");

    try {
      if (this.bot) {
        try {
          await this.bot.logout();
          console.log("[BotController] 已清除微信登录缓存");
        } catch (e) {
          console.log("[BotController] 注销会话时出现异常（可能已断线），继续执行重启流程");
        }
      }

      await this.stop();
      await this.start();
      console.log("[BotController] 重新登入流程已启动，请扫描二维码");
    } catch (e) {
      console.error("[BotController] 重新登入失败:", e);
      throw e;
    }
  }
}