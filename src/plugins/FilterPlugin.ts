import type { BotContext } from "../core.js";
import { AbstractHotReloadPlugin } from "../core/AbstractHotReloadPlugin.js";

interface FilterConfig {
  block_keywords: string[];
  block_regex_patterns: string[];
  enable_logging: boolean;
}

const DEFAULT_FILTER_CONFIG: FilterConfig = {
  block_keywords: [
    "[收到一条微信转账消息，请在手机上查看]",
    "[微信红包]",
    "[收到一条语音消息，请在手机上查看]",
    "[收到一条视频消息，请在手机上查看]",
    "[收到一条位置消息，请在手机上查看]",
  ],
  block_regex_patterns: [
    "^<\\?xml version=",
    "^<msg>",
    "^@[0-9a-fA-F]{64,}",
  ],
  enable_logging: true,
};

export class FilterPlugin extends AbstractHotReloadPlugin<FilterConfig> {
  name = "filter";
  version = "1.0.0";
  priority = 1;

  constructor() {
    super("filter.json", DEFAULT_FILTER_CONFIG);
  }

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    const text = ctx.content.trim();

    if (!text) {
      await next();
      return;
    }

    // 关键词匹配（第一轨）
    const keywordMatched = this.pluginConfig.block_keywords.some((keyword) =>
      text.includes(keyword)
    );

    if (keywordMatched) {
      if (this.pluginConfig.enable_logging) {
        console.log("[FilterPlugin] 拦截并丢弃协议脏数据");
      }
      return;
    }

    // 正则匹配（第二轨）
    for (const pattern of this.pluginConfig.block_regex_patterns) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(text)) {
          if (this.pluginConfig.enable_logging) {
            console.log("[FilterPlugin] 拦截并丢弃协议脏数据");
          }
          return;
        }
      } catch (error) {
        // 非法正则表达式，跳过该规则
        continue;
      }
    }

    // 未命中任何过滤规则，放行到下游
    await next();
  }
}
