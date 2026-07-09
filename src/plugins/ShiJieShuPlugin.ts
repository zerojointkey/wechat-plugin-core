import { MessageType } from "../core.js";
import type { BotContext } from "../core.js";
import { AbstractHotReloadPlugin } from "../core/AbstractHotReloadPlugin.js";
import { existsSync, readFileSync, readdirSync, watch } from "fs";
import { readdir } from "fs/promises";
import { resolve } from "path";

interface WorldInfoEntry {
  keys: string[];
  content: string;
  priority: number;
  constant: boolean;
}

interface WorldInfoFile {
  entries: WorldInfoEntry[];
}

interface WorldInfoConfig {
  scan_history_depth: number;
  max_token_budget: number;
  priority_offset_character: number;
  world_info_help_template: string;
  world_select_success_template: string;
  world_select_fail_template: string;
}

const DEFAULT_WORLD_INFO_CONFIG: WorldInfoConfig = {
  scan_history_depth: 2,
  max_token_budget: 1500,
  priority_offset_character: 100,
  world_info_help_template: "当前有效全局世界书包括：{{world_list}}。你可以使用 /world select [世界书ID] 进行锁定。",
  world_select_success_template: "已成功锁定全局世界观背景：[{{world_id}}].",
  world_select_fail_template: "锁定失败：未找到名为 [{{world_id}}] 的世界书文件。",
};

/**
 * 世界书插件（双轨知识增强版 + 内存缓存架构）
 * 实现类似酒馆（SillyTavern）的世界书背景设定检索注入功能
 * 支持全局宏观世界观与角色私设世界观的双轨制融合
 * 通过实时扫描最近对话上下文进行关键词激活
 * 在字数预算内执行裁剪并安全注入到系统提示词
 * 所有配置和世界书数据全量预加载到内存，通过 fs.watch 实现热重载
 */
export class ShiJieShuPlugin extends AbstractHotReloadPlugin<WorldInfoConfig> {
  name = "shijieshu";
  version = "1.0.0";
  priority = 15;

  private worldInfoDir = resolve(process.cwd(), "world_info");
  private worldInfoCache: Map<string, WorldInfoEntry[]> = new Map();
  private availableWorldsCache: string[] = [];

  constructor() {
    super("world_info.json", DEFAULT_WORLD_INFO_CONFIG);
    this.initializeWorldInfoCache();
    this.startWorldInfoWatcher();
  }

  /**
   * 初始化世界书缓存（预加载所有世界书到内存）
   */
  private initializeWorldInfoCache(): void {
    try {
      if (!existsSync(this.worldInfoDir)) {
        console.warn("[ShiJieShuPlugin] world_info 目录不存在");
        return;
      }

      const files = readdirSync(this.worldInfoDir);
      const globalIds: string[] = [];

      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = resolve(this.worldInfoDir, file);
          const entries = this.loadWorldInfoFileFromDisk(filePath);
          
          if (entries.length > 0) {
            // 使用文件名作为键（包含 global_ 前缀或角色卡 ID）
            const fileKey = file.replace(/\.json$/, "");
            this.worldInfoCache.set(fileKey, entries);

            // 如果是全局世界书，提取 ID
            if (file.startsWith("global_")) {
              const id = file.replace(/^global_/, "").replace(/\.json$/, "");
              globalIds.push(id);
            }
          }
        }
      }

      this.availableWorldsCache = globalIds.sort();
      console.log(`[ShiJieShuPlugin] 已预加载 ${this.worldInfoCache.size} 个世界书到内存`);
    } catch (error) {
      console.error("[ShiJieShuPlugin] 世界书缓存初始化失败:", error);
    }
  }

  /**
   * 启动世界书目录监听器
   */
  private startWorldInfoWatcher(): void {
    try {
      if (!existsSync(this.worldInfoDir)) {
        console.warn("[ShiJieShuPlugin] world_info 目录不存在，跳过监听器启动");
        return;
      }

      const watcher = watch(this.worldInfoDir, async (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          try {
            // 异步刷新整个缓存
            const files = await readdir(this.worldInfoDir);
            const newCache = new Map<string, WorldInfoEntry[]>();
            const globalIds: string[] = [];

            for (const file of files) {
              if (file.endsWith(".json")) {
                const filePath = resolve(this.worldInfoDir, file);
                const entries = this.loadWorldInfoFileFromDisk(filePath);
                
                if (entries.length > 0) {
                  const fileKey = file.replace(/\.json$/, "");
                  newCache.set(fileKey, entries);

                  if (file.startsWith("global_")) {
                    const id = file.replace(/^global_/, "").replace(/\.json$/, "");
                    globalIds.push(id);
                  }
                }
              }
            }

            this.worldInfoCache = newCache;
            this.availableWorldsCache = globalIds.sort();
            console.log(`[shijieshu] 世界书缓存已热重载，当前 ${this.worldInfoCache.size} 个`);
          } catch (error) {
            console.warn("[shijieshu] 警告: 检测到外部资产变更，但数据损坏，已自动隔离并沿用历史缓存。");
          }
        }
      });

      watcher.on("error", (error) => {
        console.error("[shijieshu] 世界书目录监听器异常:", error);
      });
    } catch (error) {
      console.warn("[shijieshu] 无法启动世界书目录监听器，将使用静态缓存");
    }
  }

  /**
   * 模板渲染引擎（将 {{key}} 替换为对应变量值）
   */
  private renderTemplate(template: string, variables: Record<string, any>): string {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      const replacement = value !== undefined && value !== null ? String(value) : "";
      result = result.split(placeholder).join(replacement);
    }
    return result;
  }

  /**
   * 获取所有可用的全局世界书 ID 列表（直接从内存缓存读取）
   */
  private listGlobalWorlds(): string[] {
    return this.availableWorldsCache;
  }

  /**
   * 从磁盘加载世界书文件（返回 entries 数组，失败返回空数组）
   * 支持两种格式：
   * 1. 简化格式：{ "entries": [ {...}, {...} ] }
   * 2. SillyTavern 格式：{ "entries": { "1": {...}, "2": {...} } }
   */
  private loadWorldInfoFileFromDisk(filePath: string): WorldInfoEntry[] {
    try {
      if (!existsSync(filePath)) {
        return [];
      }

      const content = readFileSync(filePath, "utf-8");
      const rawData = JSON.parse(content);

      if (!rawData.entries) {
        console.warn("[ShiJieShuPlugin] 世界书文件格式错误（缺少 entries 字段）:", filePath);
        return [];
      }

      // 格式检测与适配
      let normalizedEntries: WorldInfoEntry[] = [];

      // 情况 1：简化数组格式 { entries: [...] }
      if (Array.isArray(rawData.entries)) {
        normalizedEntries = rawData.entries;
      }
      // 情况 2：SillyTavern 对象格式 { entries: { "1": {...}, "2": {...} } }
      else if (typeof rawData.entries === "object") {
        normalizedEntries = this.convertSillyTavernFormat(rawData.entries);
      } else {
        console.warn("[ShiJieShuPlugin] 世界书文件 entries 字段类型无法识别:", filePath);
        return [];
      }

      return normalizedEntries;
    } catch (error) {
      console.error("[ShiJieShuPlugin] 加载世界书文件失败:", filePath, error);
      return [];
    }
  }

  /**
   * 加载世界书文件（优先从缓存读取，缓存未命中时降级读盘）
   */
  private loadWorldInfoFile(fileKey: string): WorldInfoEntry[] {
    // 优先从缓存读取
    if (this.worldInfoCache.has(fileKey)) {
      return this.worldInfoCache.get(fileKey)!;
    }

    // 缓存未命中，降级读盘
    const filePath = resolve(this.worldInfoDir, `${fileKey}.json`);
    return this.loadWorldInfoFileFromDisk(filePath);
  }

  /**
   * 将 SillyTavern 格式转换为内部统一格式
   * SillyTavern 格式：
   * {
   *   "1": { "key": ["关键词1", "关键词2"], "content": "...", "order": 10, "constant": false, "disable": false, ... }
   * }
   * 
   * 内部格式：
   * [
   *   { "keys": ["关键词1", "关键词2"], "content": "...", "priority": 10, "constant": false }
   * ]
   */
  private convertSillyTavernFormat(sillyTavernEntries: Record<string, any>): WorldInfoEntry[] {
    const result: WorldInfoEntry[] = [];

    try {
      for (const [uid, entry] of Object.entries(sillyTavernEntries)) {
        // 跳过被禁用的条目
        if (entry.disable === true) {
          continue;
        }

        // 字段映射与默认值兜底
        const normalizedEntry: WorldInfoEntry = {
          keys: Array.isArray(entry.key) ? entry.key : [],
          content: typeof entry.content === "string" ? entry.content : "",
          priority: typeof entry.order === "number" ? entry.order : 10,
          constant: entry.constant === true,
        };

        // 验证必需字段
        if (normalizedEntry.keys.length === 0 || !normalizedEntry.content) {
          console.warn(`[ShiJieShuPlugin] 跳过无效条目 uid=${uid}（keys 或 content 为空）`);
          continue;
        }

        result.push(normalizedEntry);
      }
    } catch (error) {
      console.error("[ShiJieShuPlugin] SillyTavern 格式转换异常:", error);
    }

    return result;
  }

  /**
   * 组装扫描文本目标（当前输入 + 最近的历史记录）
   */
  private assembleScanTarget(ctx: BotContext): string {
    const parts: string[] = [ctx.content];

    // 获取最近的历史记录（边界防御）
    const historyDepth = this.pluginConfig.scan_history_depth;
    const history = ctx.session.chatHistory || [];
    const startIndex = Math.max(0, history.length - historyDepth);
    const recentHistory = history.slice(startIndex);

    for (const msg of recentHistory) {
      if (msg.content) {
        parts.push(msg.content);
      }
    }

    return parts.join("\n").toLowerCase();
  }

  /**
   * 检查条目是否激活（constant 强制激活 或 关键词匹配）
   */
  private isEntryActive(entry: WorldInfoEntry, scanTarget: string): boolean {
    // 常驻条目直接激活
    if (entry.constant) {
      return true;
    }

    // 关键词匹配（不区分大小写）
    if (Array.isArray(entry.keys)) {
      for (const key of entry.keys) {
        if (key && scanTarget.includes(key.toLowerCase())) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Token 预算裁剪（按优先级降序排序，累加到预算上限）
   */
  private pruneByBudget(entries: WorldInfoEntry[], maxBudget: number): string {
    // 按优先级降序排序
    const sorted = entries.slice().sort((a, b) => b.priority - a.priority);

    const parts: string[] = [];
    let totalLength = 0;

    for (const entry of sorted) {
      const contentLength = entry.content.length;
      if (totalLength + contentLength <= maxBudget) {
        parts.push(entry.content);
        totalLength += contentLength;
      } else {
        // 超出预算，停止累加
        break;
      }
    }

    return parts.join("\n\n");
  }

  async onMessage(ctx: BotContext, next: () => Promise<void>): Promise<void> {
    // 仅处理文本消息
    if (ctx.messageType !== MessageType.Text) {
      await next();
      return;
    }

    const content = ctx.content.trim();

    // ========== 指令拦截 1: /world（列出所有全局世界书） ==========
    if (content === "/world") {
      const worlds = this.listGlobalWorlds();
      ctx.reply = this.renderTemplate(this.pluginConfig.world_info_help_template, {
        world_list: worlds.length > 0 ? worlds.join("、") : "无可用世界书",
      });
      return;
    }

    // ========== 指令拦截 2: /world select xxx（锁定全局世界书，标准写法） ==========
    // ========== 指令拦截 3: /world xxx（锁定全局世界书，快捷省略写法） ==========
    // 两路统一处理：先匹配 /world select xxx，再匹配 /world xxx（需排除纯 /world 已被上方拦截）
    const selectPrefix = "/world select ";
    const shortPrefix = "/world ";
    let worldIdToSelect: string | null = null;

    if (content.startsWith(selectPrefix)) {
      worldIdToSelect = content.slice(selectPrefix.length).trim();
    } else if (content.startsWith(shortPrefix)) {
      worldIdToSelect = content.slice(shortPrefix.length).trim();
    }

    if (worldIdToSelect !== null) {
      const worldId = worldIdToSelect;

      if (!worldId) {
        ctx.reply = this.renderTemplate(this.pluginConfig.world_select_fail_template, {
          world_id: "",
        });
        return;
      }

      const worldPath = resolve(this.worldInfoDir, `global_${worldId}.json`);

      if (existsSync(worldPath)) {
        ctx.session.meta.currentGlobalWorldInfo = worldId;
        ctx.reply = this.renderTemplate(this.pluginConfig.world_select_success_template, {
          world_id: worldId,
        });
        console.log(`[ShiJieShuPlugin] 用户 ${ctx.session.sessionId} 锁定全局世界书: ${worldId}`);
      } else {
        ctx.reply = this.renderTemplate(this.pluginConfig.world_select_fail_template, {
          world_id: worldId,
        });
      }

      return;
    }

    // ========== 普通消息路径：双轨扫描 + Token 裁剪 + 注入 ==========

    const allEntries: WorldInfoEntry[] = [];

    // 全局轨：加载锁定的全局世界书
    const globalWorldId = ctx.session.meta.currentGlobalWorldInfo as string | undefined;
    if (globalWorldId) {
      const globalEntries = this.loadWorldInfoFile(`global_${globalWorldId}`);
      allEntries.push(...globalEntries);
    }

    // 角色轨：加载角色卡绑定的世界书
    const personaWorldInfoId = ctx.session.meta.currentPersonaWorldInfo as string | undefined;
    if (personaWorldInfoId) {
      const personaEntries = this.loadWorldInfoFile(personaWorldInfoId);

      // 为角色轨条目增加优先级偏移
      for (const entry of personaEntries) {
        entry.priority += this.pluginConfig.priority_offset_character;
      }

      allEntries.push(...personaEntries);
    }

    // 如果没有任何世界书数据，直接放行
    if (allEntries.length === 0) {
      await next();
      return;
    }

    // 组装扫描文本目标
    const scanTarget = this.assembleScanTarget(ctx);

    // 筛选激活的条目
    const activeEntries = allEntries.filter((entry) => this.isEntryActive(entry, scanTarget));

    // 如果没有激活的条目，直接放行
    if (activeEntries.length === 0) {
      await next();
      return;
    }

    // Token 预算裁剪
    const compiledText = this.pruneByBudget(activeEntries, this.pluginConfig.max_token_budget);

    // 注入到系统提示词（追加模式）
    const currentSystemPrompt = (ctx.session.meta.systemPrompt as string) || "";
    ctx.session.meta.systemPrompt = currentSystemPrompt + "\n\n[补充背景知识]\n" + compiledText;

    console.log(
      `[ShiJieShuPlugin] 激活 ${activeEntries.length} 条世界书条目，注入字符数: ${compiledText.length}`
    );

    // 放行消息流向下游
    await next();
  }
}
