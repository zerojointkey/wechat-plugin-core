import { BasePlugin, MessageType } from "../core.js";
import type { BotContext } from "../core.js";

export class ShiTuPlugin extends BasePlugin {
  name = "shitu";
  version = "1.0.0";
  priority = 10;

  private cache = new Map<string, { b64Images: string[]; cachedAt: number }>();

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    if (ctx.messageType === MessageType.Image) {
      try {
        const fileBox = await ctx.rawMessage.toFileBox();
        const buffer = await fileBox.toBuffer();
        const b64 = buffer.toString("base64");

        const key = ctx.isRoom ? `${ctx.room!.id}_${ctx.talker.id}` : ctx.talker.id;

        let entry = this.cache.get(key);
        if (!entry) {
          entry = { b64Images: [], cachedAt: Date.now() };
          this.cache.set(key, entry);
        }

        const maxImages = ctx.isRoom ? 3 : 1;
        entry.b64Images.push(b64);
        if (entry.b64Images.length > maxImages) {
          entry.b64Images = entry.b64Images.slice(-maxImages);
        }
        entry.cachedAt = Date.now();

        console.log(
          `[ShiTuPlugin] 已缓存图片 (${ctx.isRoom ? "群聊" : "私聊"}) | key: ${key} | 当前缓存数: ${entry.b64Images.length}`
        );
      } catch (error) {
        console.error("[ShiTuPlugin] 图片处理失败:", error);
      }
      return;
    }

    if (ctx.messageType === MessageType.Text) {
      const key = ctx.isRoom ? `${ctx.room!.id}_${ctx.talker.id}` : ctx.talker.id;
      const entry = this.cache.get(key);

      if (entry) {
        const now = Date.now();
        const ttl = 5 * 60 * 1000;

        if (now - entry.cachedAt > ttl) {
          this.cache.delete(key);
          console.log(`[ShiTuPlugin] 缓存已超时清除 | key: ${key}`);
          await next();
          return;
        }

        if (entry.b64Images.length > 0) {
          for (const img of entry.b64Images) {
            ctx.attachments.push({
              type: "image",
              mimeType: "image/jpeg",
              data: img,
            });
          }
          console.log(
            `[ShiTuPlugin] 已推入通用附件 | key: ${key} | 图片数: ${entry.b64Images.length}`
          );

          await next();

          this.cache.delete(key);
          console.log(`[ShiTuPlugin] 缓存已清除（回溯期） | key: ${key}`);
          return;
        }
      }
    }

    await next();
  }
}
