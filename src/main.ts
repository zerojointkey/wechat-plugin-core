import { WechatyBuilder } from "wechaty";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { ChatGPTBot, pluginManager } from "./core.js";
import { BotController } from "./core/BotController.js";

const chatGPTBot = new ChatGPTBot();

const botFactory = () =>
  WechatyBuilder.build({
    name: "wechat-assistant",
    puppet: "wechaty-puppet-wechat",
    puppetOptions: { uos: true },
  });

const controller = new BotController(botFactory, chatGPTBot);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function getLLMPlugin() {
  const plugins = pluginManager.listPlugins();
  return plugins.find((p) => p.name === "llm") as any;
}

function maskApiKey(key: string): string {
  if (!key || key.length <= 11) return "***";
  return key.substring(0, 7) + "***" + key.substring(key.length - 4);
}

function renderMenu() {
  console.clear();
  console.log("======================================");
  console.log("wechat-chatgpt 机器人运营控制台");
  console.log("======================================");
  console.log(`当前状态: ${controller.getStatus()}`);
  console.log("--------------------------------------");
  console.log("1. 启动机器人");
  console.log("2. 关闭机器人");
  console.log("3. 重新登入微信 (清除缓存并重刷二维码)");
  console.log("4. 系统参数配置面板 (API / 密钥 / 全局资产)");
  console.log("5. 退出控制台");
  console.log("======================================");
  rl.question("请输入操作编号 (1-5): ", handleInput);
}

async function handleInput(input: string) {
  const choice = input.trim();

  try {
    switch (choice) {
      case "1":
        console.log("\n正在启动机器人...\n");
        await controller.start();
        break;

      case "2":
        console.log("\n正在关闭机器人...\n");
        await controller.stop();
        renderMenu();
        break;

      case "3":
        console.log("\n正在重新登入微信...\n");
        await controller.relogin();
        break;

      case "4":
        renderSubMenu();
        break;

      case "5":
        console.log("\n正在安全退出控制台...\n");
        await controller.stop();
        rl.close();
        process.exit(0);
        break;

      default:
        console.log("\n错误: 无效的操作编号，请输入 1-5 之间的数字\n");
        rl.question("请输入操作编号 (1-5): ", handleInput);
        break;
    }
  } catch (e) {
    console.error("\n操作执行失败:", e);
    setTimeout(() => {
      renderMenu();
    }, 2000);
  }
}

function renderSubMenu() {
  console.clear();
  console.log("--------------------------------------");
  console.log("系统参数配置面板");
  console.log("--------------------------------------");

  const llmPlugin = getLLMPlugin();
  if (llmPlugin && llmPlugin.getConfig) {
    const config = llmPlugin.getConfig();
    console.log(`1. 修改 API URL  (当前: ${config.api_url || "未配置"})`);
    console.log(`2. 修改 API Key  (当前: ${maskApiKey(config.api_key)})`);
    console.log(`3. 切换模型      (当前: ${config.model || "未配置"})`);
  } else {
    console.log("1. 修改 API URL  (当前: 插件未加载)");
    console.log("2. 修改 API Key  (当前: 插件未加载)");
    console.log("3. 切换模型      (当前: 插件未加载)");
  }

  console.log("4. 切换全局默认人格 (扫描 cards/ 目录)");
  console.log("5. 切换全局默认世界书 (扫描 world_info/ 目录)");
  console.log("6. 返回主菜单");
  console.log("--------------------------------------");
  rl.question("请输入操作编号 (1-6): ", handleSubInput);
}

async function handleSubInput(input: string) {
  const choice = input.trim();

  try {
    switch (choice) {
      case "1":
        await modifyApiUrl();
        break;

      case "2":
        await modifyApiKey();
        break;

      case "3":
        await modifyModel();
        break;

      case "4":
        await switchPersona();
        break;

      case "5":
        await switchWorldInfo();
        break;

      case "6":
        renderMenu();
        break;

      default:
        console.log("\n错误: 无效的操作编号，请输入 1-6 之间的数字\n");
        setTimeout(() => renderSubMenu(), 1000);
        break;
    }
  } catch (e) {
    console.error("\n操作执行失败:", e);
    setTimeout(() => renderSubMenu(), 2000);
  }
}

async function modifyApiUrl() {
  rl.question("\n请输入新的 API URL (留空保留原值): ", async (newUrl) => {
    const trimmed = newUrl.trim();
    if (!trimmed) {
      console.log("\n已取消修改");
      setTimeout(() => renderSubMenu(), 1000);
      return;
    }

    try {
      const configPath = path.resolve(process.cwd(), "configs/llm.json");
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      config.api_url = trimmed;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const llmPlugin = getLLMPlugin();
      if (llmPlugin && llmPlugin.reloadConfig) {
        llmPlugin.reloadConfig();
      }

      console.log("\n配置已更新: API URL");
      setTimeout(() => renderSubMenu(), 1000);
    } catch (error) {
      console.error("\n配置写入失败:", error);
      setTimeout(() => renderSubMenu(), 2000);
    }
  });
}

async function modifyApiKey() {
  rl.question("\n请输入新的 API Key (留空保留原值): ", async (newKey) => {
    const trimmed = newKey.trim();
    if (!trimmed) {
      console.log("\n已取消修改");
      setTimeout(() => renderSubMenu(), 1000);
      return;
    }

    try {
      const configPath = path.resolve(process.cwd(), "configs/llm.json");
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      config.api_key = trimmed;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

      const llmPlugin = getLLMPlugin();
      if (llmPlugin && llmPlugin.reloadConfig) {
        llmPlugin.reloadConfig();
      }

      console.log("\n配置已更新: API Key");
      setTimeout(() => renderSubMenu(), 1000);
    } catch (error) {
      console.error("\n配置写入失败:", error);
      setTimeout(() => renderSubMenu(), 2000);
    }
  });
}

async function modifyModel() {
  console.log("\n可选模型列表:");
  console.log("1. gpt-4o");
  console.log("2. gpt-4-turbo");
  console.log("3. gpt-4");
  console.log("4. gpt-3.5-turbo");
  console.log("5. 自定义模型名称 (手动输入)");

  rl.question("\n请输入选项编号 (1-5): ", (choice) => {
    const trimmed = choice.trim();
    
    const presetModels = ["gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"];
    const index = parseInt(trimmed, 10);

    if (index >= 1 && index <= 4) {
      const selectedModel = presetModels[index - 1];
      writeModelConfig(selectedModel);
    } else if (index === 5) {
      rl.question("\n请输入自定义模型名称: ", (customModel) => {
        const model = customModel.trim();
        if (!model) {
          console.log("\n已取消修改");
          setTimeout(() => renderSubMenu(), 1000);
          return;
        }
        writeModelConfig(model);
      });
    } else {
      console.log("\n无效的选项编号");
      setTimeout(() => renderSubMenu(), 1000);
    }
  });
}

function writeModelConfig(model: string) {
  try {
    const configPath = path.resolve(process.cwd(), "configs/llm.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    config.model = model;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    const llmPlugin = getLLMPlugin();
    if (llmPlugin && llmPlugin.reloadConfig) {
      llmPlugin.reloadConfig();
    }

    console.log(`\n配置已更新: 模型 = ${model}`);
    setTimeout(() => renderSubMenu(), 1000);
  } catch (error) {
    console.error("\n配置写入失败:", error);
    setTimeout(() => renderSubMenu(), 2000);
  }
}

async function switchPersona() {
  try {
    const cardsDir = path.resolve(process.cwd(), "cards");
    const files = fs.readdirSync(cardsDir);
    const jsonCards = files.filter((f) => f.endsWith(".json"));

    if (jsonCards.length === 0) {
      console.log("\n未找到任何角色卡文件 (.json)");
      setTimeout(() => renderSubMenu(), 2000);
      return;
    }

    console.log("\n可用角色卡列表:");
    jsonCards.forEach((card, index) => {
      const cardId = path.basename(card, ".json");
      console.log(`${index + 1}. ${cardId}`);
    });

    rl.question("\n请输入角色卡编号: ", (choice) => {
      const index = parseInt(choice.trim(), 10) - 1;
      if (index < 0 || index >= jsonCards.length) {
        console.log("\n无效的编号");
        setTimeout(() => renderSubMenu(), 1000);
        return;
      }

      const selectedCard = path.basename(jsonCards[index], ".json");

      try {
        const configPath = path.resolve(process.cwd(), "configs/renshe.json");
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        config.default_persona = selectedCard;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

        console.log(`\n配置已更新: 默认人格 = ${selectedCard}`);
        setTimeout(() => renderSubMenu(), 1000);
      } catch (error) {
        console.error("\n配置写入失败:", error);
        setTimeout(() => renderSubMenu(), 2000);
      }
    });
  } catch (error) {
    console.error("\n扫描角色卡目录失败:", error);
    setTimeout(() => renderSubMenu(), 2000);
  }
}

async function switchWorldInfo() {
  try {
    const worldDir = path.resolve(process.cwd(), "world_info");
    const files = fs.readdirSync(worldDir);
    const globalWorlds = files.filter((f) => f.startsWith("global_") && f.endsWith(".json"));

    if (globalWorlds.length === 0) {
      console.log("\n未找到任何全局世界书文件 (global_*.json)");
      setTimeout(() => renderSubMenu(), 2000);
      return;
    }

    console.log("\n可用全局世界书列表:");
    console.log("0. (无) - 清除默认世界书");
    globalWorlds.forEach((world, index) => {
      const worldId = path.basename(world, ".json");
      console.log(`${index + 1}. ${worldId}`);
    });

    rl.question("\n请输入世界书编号: ", (choice) => {
      const index = parseInt(choice.trim(), 10);

      let selectedWorld = "";
      if (index === 0) {
        selectedWorld = "";
      } else if (index > 0 && index <= globalWorlds.length) {
        selectedWorld = path.basename(globalWorlds[index - 1], ".json");
      } else {
        console.log("\n无效的编号");
        setTimeout(() => renderSubMenu(), 1000);
        return;
      }

      try {
        const configPath = path.resolve(process.cwd(), "configs/world_info.json");
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = JSON.parse(raw);
        config.default_global_world = selectedWorld;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

        console.log(`\n配置已更新: 默认世界书 = ${selectedWorld || "(无)"}`);
        setTimeout(() => renderSubMenu(), 1000);
      } catch (error) {
        console.error("\n配置写入失败:", error);
        setTimeout(() => renderSubMenu(), 2000);
      }
    });
  } catch (error) {
    console.error("\n扫描世界书目录失败:", error);
    setTimeout(() => renderSubMenu(), 2000);
  }
}

controller.onUIRequestRefresh = () => {
  setTimeout(() => {
    renderMenu();
  }, 500);
};

renderMenu();