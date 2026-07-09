# WeChat Bot - Pluggable Architecture Framework

一个经过极致精简、基于洋葱模型（Onion Middleware）的轻量化微信机器人插件底座。

## 项目简介

这是一个完全解耦的微信机器人骨架，采用双向洋葱模型实现插件化架构。核心代码仅约 200 行，提供了一套高内聚、低耦合的可扩展框架，让开发者专注于业务逻辑插件的编写，而不必关心底层的消息路由和会话管理。

## 核心优势

- **极致精简**：核心骨架（`main.ts` + `core.ts`）总共约 200 行代码
- **完全解耦**：底层框架与业务逻辑完全分离，插件即插即用
- **零配置加载**：动态扫描 `src/plugins/` 目录，自动注册所有插件
- **洋葱模型**：插件按优先级顺序执行，支持双向拦截和数据透传
- **类型安全**：完整的 TypeScript 类型支持，编译期即可发现错误

## 架构特性

### 1. 动态插件系统

插件自动扫描加载机制，只需将插件文件放入 `src/plugins/` 目录即可：

```typescript
export class YourPlugin extends BasePlugin {
  name = "your-plugin";
  version = "1.0.0";
  priority = 50;  // 数字越小优先级越高

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    // 前置逻辑
    await next();  // 调用下一个插件
    // 后置逻辑（回溯阶段）
  }
}
```

### 2. BotContext.reply 统一分发

插件不再直接调用 `message.say()`，而是将回复内容赋值给 `ctx.reply`，由核心层在洋葱模型回溯完成后统一发送。这使得后续插件可以在回溯阶段对回复内容进行拦截、加工或多模态渲染。

```typescript
// 插件中设置回复
ctx.reply = "这是回复内容";
await next();  // 允许其他插件拦截或加工
```

### 3. 多模态数据通道

原生支持多模态消息格式，已为视觉模型拓宽类型限制：

```typescript
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; [key: string]: any }>;
}

export interface BotContext {
  // ... 其他字段
  reply: string | Array<{ type: string; [key: string]: any }> | undefined;
}
```

图片消息已放行进入插件管道，可通过 `ctx.rawMessage.toFileBox()` 获取图片并传递给多模态 API。

### 4. 会话管理

内置会话存储系统，支持按联系人或群组自动维护上下文：

```typescript
ctx.session.chatHistory  // 历史对话记录
ctx.session.meta         // 自定义元数据（如 systemPrompt）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入必要的配置：

```env
OPENAI_API_BASE_URL="https://api.openai.com/v1"
OPENAI_API_KEY="your-api-key-here"
LLM_MODEL="gpt-3.5-turbo"
TEMPERATURE="0.6"
```

### 3. 启动项目

```bash
npm run dev
```

首次启动会显示二维码，使用微信扫码登录即可。

## 项目结构

```
src/
├── core.ts              # 核心框架（类型定义、插件管理器、消息路由）
├── main.ts              # 入口文件（Wechaty 初始化）
└── plugins/             # 插件目录
    ├── LLMPlugin.ts     # 大模型底座插件
    └── ...              # 其他自定义插件
```

## 环境变量说明

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `OPENAI_API_BASE_URL` | OpenAI 兼容接口的 Base URL | - |
| `OPENAI_API_KEY` | API 密钥 | - |
| `LLM_MODEL` | 使用的模型名称 | `gpt-3.5-turbo` |
| `TEMPERATURE` | 温度参数（0-2） | `0.6` |
| `CHAT_PRIVATE_TRIGGER_KEYWORD` | 私聊触发关键词 | 空（无需触发） |
| `CHAT_TRIGGER_RULE` | 触发规则正则表达式 | - |
| `DISABLE_GROUP_MESSAGE` | 禁用群聊消息处理 | `false` |
| `BLOCK_WORDS` | 屏蔽词列表（逗号分隔） | - |
| `CHATGPT_BLOCK_WORDS` | AI 回复屏蔽词列表（逗号分隔） | - |

## 内置插件

### LLMPlugin

大模型底座插件，提供基础的 AI 对话能力：

- 优先级：99（最低，最后执行）
- 支持通过 `ctx.session.meta.systemPrompt` 注入人设提示词
- 自动维护对话历史（最多保留 20 轮）
- 使用 OpenAI 兼容接口

## 开发指南

### 创建新插件

1. 在 `src/plugins/` 目录下创建新文件
2. 继承 `BasePlugin` 类并实现 `onMessage` 方法
3. 设置合理的优先级（数字越小越先执行）
4. 保存文件，重启项目即可自动加载

示例：

```typescript
import { BasePlugin } from "../core.js";
import type { BotContext } from "../core.js";

export class GreetingPlugin extends BasePlugin {
  name = "greeting";
  version = "1.0.0";
  priority = 10;  // 高优先级，优先处理

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    if (ctx.content === "/hello") {
      ctx.reply = "你好，我是机器人";
      await next();  // 允许其他插件处理
      return;
    }
    await next();  // 不处理，交给下一个插件
  }
}
```

### 插件优先级建议

- `1-20`：前置拦截插件（权限检查、敏感词过滤）
- `21-50`：功能插件（指令处理、特殊功能）
- `51-98`：中间件插件（日志记录、数据转换）
- `99`：大模型底座（兜底处理）

## 技术栈

- **运行时**：Node.js 18+
- **语言**：TypeScript
- **微信接口**：Wechaty
- **大模型**：OpenAI 兼容 API

## 许可证

ISC

## 贡献

欢迎提交 Issue 和 Pull Request。