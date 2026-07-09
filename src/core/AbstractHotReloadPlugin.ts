import { BasePlugin } from "../core.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync, watch } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";

/**
 * 泛型热重载插件抽象基类
 * 
 * 封装了配置文件的热重载通用逻辑：
 * - 自动确保配置文件存在（不存在则创建默认配置）
 * - 同步加载初始配置
 * - 启动 fs.watch 文件监听器
 * - 安全的异步热重载（带 JSON 解析异常隔离）
 * 
 * @template T 配置文件的类型结构
 */
export abstract class AbstractHotReloadPlugin<T> extends BasePlugin {
  protected pluginConfig!: T;

  private configsDir = resolve(process.cwd(), "configs");
  private configPath: string;
  private configFileName: string;
  private defaultConfig: T;

  /**
   * 构造函数
   * 
   * @param configFileName 配置文件名（例如：filter.json、renshe.json）
   * @param defaultConfig 默认配置对象（当配置文件不存在时使用）
   */
  constructor(configFileName: string, defaultConfig: T) {
    super();
    this.configFileName = configFileName;
    this.configPath = resolve(this.configsDir, configFileName);
    this.defaultConfig = defaultConfig;

    this.ensureConfig();
    this.pluginConfig = this.loadConfigSync();
    this.startFileWatcher();
  }

  /**
   * 确保配置文件存在（幂等检测）
   * 若文件不存在则初始化同步写入 defaultConfig
   */
  private ensureConfig(): void {
    try {
      if (!existsSync(this.configsDir)) {
        mkdirSync(this.configsDir, { recursive: true });
      }

      if (!existsSync(this.configPath)) {
        writeFileSync(
          this.configPath,
          JSON.stringify(this.defaultConfig, null, 2),
          "utf-8"
        );
      }
    } catch (error) {
      // 配置文件创建失败，静默降级，使用内存默认配置
    }
  }

  /**
   * 同步加载配置文件（仅在初始化时使用）
   */
  private loadConfigSync(): T {
    try {
      const rawData = readFileSync(this.configPath, "utf-8");
      return JSON.parse(rawData) as T;
    } catch (error) {
      return { ...this.defaultConfig };
    }
  }

  /**
   * 启动文件监听器（fs.watch 异步模型）
   * 安全降级断路器：JSON 解析失败时拒绝更新内存，沿用历史缓存
   */
  private startFileWatcher(): void {
    try {
      const watcher = watch(this.configPath, async (eventType) => {
        if (eventType === "change") {
          try {
            const rawData = await readFile(this.configPath, "utf-8");
            const parsedConfig = JSON.parse(rawData) as T;
            this.pluginConfig = parsedConfig;
            console.log(`[${this.name}] 配置文件已热重载`);
          } catch (error) {
            console.warn(
              `[${this.name}] 警告: 检测到外部资产变更，但数据损坏，已自动隔离并沿用历史缓存。`
            );
          }
        }
      });

      watcher.on("error", (error) => {
        console.error(`[${this.name}] 文件监听器异常:`, error);
      });
    } catch (error) {
      console.warn(`[${this.name}] 无法启动文件监听器，将使用静态配置`);
    }
  }

  /**
   * 启动通用目录监听器（fs.watch 异步模型）
   *
   * 用于监听非配置类的资源目录（例如角色卡目录、世界书目录）。
   * 安全降级断路器：回调执行异常时拒绝崩溃，打印纯文本警告并维持内存资产不变。
   *
   * @param dirPath 待监听的目录绝对路径
   * @param onChange 目录内容发生变更时触发的回调（支持同步或异步）
   */
  protected startDirectoryWatcher(
    dirPath: string,
    onChange: () => Promise<void> | void
  ): void {
    try {
      const watcher = watch(dirPath, async (eventType) => {
        if (eventType === "change" || eventType === "rename") {
          try {
            await onChange();
          } catch (error) {
            console.warn(
              `[${this.name}] 警告: 检测到目录资产变更，但回调处理异常，已自动隔离并沿用历史内存资产。`
            );
          }
        }
      });

      watcher.on("error", (error) => {
        console.error(`[${this.name}] 目录监听器异常:`, error);
      });
    } catch (error) {
      console.warn(`[${this.name}] 无法启动目录监听器: ${dirPath}，将使用静态内存资产`);
    }
  }
}
