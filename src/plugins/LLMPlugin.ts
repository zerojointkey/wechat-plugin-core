import { envConfig } from "../core.js";
import type { BotContext, ChatMessage } from "../core.js";
import { AbstractHotReloadPlugin } from "../core/AbstractHotReloadPlugin.js";

interface LLMConfig {
  api_url: string;
  api_key: string;
  model: string;
}

const DEFAULT_LLM_CONFIG: LLMConfig = {
  api_url: envConfig.llm.baseUrl || "",
  api_key: envConfig.llm.apiKey || "",
  model: envConfig.llm.model || "gpt-4o",
};

/**
 * 纯净的大模型底座插件
 * - 使用标准 fetch 调用 OpenAI 兼容接口
 * - 支持通过 ctx.session.meta.systemPrompt 注入人设提示词
 * - 自动维护 chatHistory 上下文
 * - 配置文件热重载支持
 */
export class LLMPlugin extends AbstractHotReloadPlugin<LLMConfig> {
  name = "llm";
  version = "1.0.0";
  priority = 99;

  constructor() {
    super("llm.json", DEFAULT_LLM_CONFIG);
  }

  public reloadConfig(): void {
    // 兼容旧接口，现在配置会自动热重载
  }

  public getConfig(): LLMConfig {
    return { ...this.pluginConfig };
  }

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    const { api_url, api_key, model } = this.pluginConfig;
    const temperature = envConfig.llm.temperature;

    if (!api_url || !api_key) {
      console.warn("[LLMPlugin] 缺少 LLM 配置（api_url 或 api_key），跳过处理");
      await next();
      return;
    }

    if (!ctx.content.trim()) {
      await next();
      return;
    }

    const messages: ChatMessage[] = [];

    const systemPrompt = ctx.session.meta.systemPrompt as string | undefined;
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    messages.push(...ctx.session.chatHistory);

    if (ctx.attachments.length > 0) {
      const multimodalContent: Array<{ type: string; [key: string]: unknown }> = [
        { type: "text", text: ctx.content },
        ...ctx.attachments
          .filter((att) => att.type === "image")
          .map((att) => ({
            type: "image_url",
            image_url: { url: `data:${att.mimeType};base64,${att.data}` },
          })),
      ];
      messages.push({ role: "user", content: multimodalContent as unknown as string });
    } else {
      messages.push({ role: "user", content: ctx.content });
    }

    try {
      const response = await fetch(`${api_url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${api_key}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LLMPlugin] API 请求失败: ${response.status} ${errorText}`);
        ctx.reply = "抱歉，AI 服务暂时不可用，请稍后再试。";
        await next();
        return;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      const reply = data.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        console.warn("[LLMPlugin] API 返回为空");
        ctx.reply = "抱歉，未能获取到回复，请稍后再试。";
        await next();
        return;
      }

      ctx.reply = reply;

      const historyContent = ctx.attachments.length > 0
        ? `[图片] ${ctx.content}`
        : ctx.content;
      ctx.session.chatHistory.push({ role: "user", content: historyContent });
      ctx.session.chatHistory.push({ role: "assistant", content: reply });

      const maxHistory = 40;
      if (ctx.session.chatHistory.length > maxHistory) {
        ctx.session.chatHistory = ctx.session.chatHistory.slice(-maxHistory);
      }
    } catch (error) {
      console.error("[LLMPlugin] 请求异常:", error);
      ctx.reply = "抱歉，网络异常，请稍后再试。";
    }
    await next();
  }
}