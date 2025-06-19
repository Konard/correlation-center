import 'dotenv/config';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { Telegraf } from 'telegraf';
import Storage from './storage.js';
import { v7 as uuidv7 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load localization files
const locales = {
  en: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales/en.json'))),
  ru: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales/ru.json'))),
};

// Translation helper
function t(ctx, key, vars = {}) {
  const lang = locales[ctx.from.language_code] ? ctx.from.language_code : 'en';
  let text = locales[lang][key] || locales['en'][key] || key;
  Object.keys(vars).forEach((k) => {
    text = text.replace(`{{${k}}}`, vars[k]);
  });
  return text;
}

// Initialize database
const storage = new Storage();
await storage.initDB();

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  await storage.readDB();
  storage.getUserData(ctx);
  await storage.writeDB();
  await ctx.reply(t(ctx, 'welcome'));
});

bot.command('addneed', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const input = ctx.message.text.split(' ').slice(1).join(' ');
  if (!input) return ctx.reply(t(ctx, 'addNeedUsage'));
  const need = {
    requestor: ctx.from.username || ctx.from.first_name || 'unknown',
    guid: uuidv7(),
    description: input
  };
  user.needs.push(need);
  await storage.writeDB();
  ctx.reply(t(ctx, 'addNeedSuccess', { item: input }));
});

bot.command('listneeds', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (user.needs.length === 0) return ctx.reply(t(ctx, 'noNeeds'));
  const list = user.needs.map((n, i) => `${i + 1}. ${n.description} (by ${n.requestor}, id: ${n.guid})`).join('\n');
  ctx.reply(t(ctx, 'listNeeds', { list }));
});

bot.command('deleteneed', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const arg = ctx.message.text.split(' ')[1];
  const index = parseInt(arg, 10);
  if (!arg || isNaN(index) || index < 1 || index > user.needs.length) {
    return ctx.reply(t(ctx, 'deleteNeedUsage'));
  }
  const removed = user.needs.splice(index - 1, 1)[0];
  await storage.writeDB();
  ctx.reply(t(ctx, 'deleteNeedSuccess', { item: removed.description }));
});

bot.command('addresource', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const input = ctx.message.text.split(' ').slice(1).join(' ');
  if (!input) return ctx.reply(t(ctx, 'addResourceUsage'));
  const resource = {
    supplier: ctx.from.username || ctx.from.first_name || 'unknown',
    guid: uuidv7(),
    description: input
  };
  user.resources.push(resource);
  await storage.writeDB();
  ctx.reply(t(ctx, 'addResourceSuccess', { item: input }));
});

bot.command('listresources', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  if (user.resources.length === 0) return ctx.reply(t(ctx, 'noResources'));
  const list = user.resources.map((r, i) => `${i + 1}. ${r.description} (by ${r.supplier}, id: ${r.guid})`).join('\n');
  ctx.reply(t(ctx, 'listResources', { list }));
});

bot.command('deleteresource', async (ctx) => {
  await storage.readDB();
  const user = storage.getUserData(ctx);
  const arg = ctx.message.text.split(' ')[1];
  const index = parseInt(arg, 10);
  if (!arg || isNaN(index) || index < 1 || index > user.resources.length) {
    return ctx.reply(t(ctx, 'deleteResourceUsage'));
  }
  const removed = user.resources.splice(index - 1, 1)[0];
  await storage.writeDB();
  ctx.reply(t(ctx, 'deleteResourceSuccess', { item: removed.description }));
});

bot.command('help', async (ctx) => {
  await ctx.reply(t(ctx, 'help'));
});

// Launch bot
console.log('Launching bot...');
bot.launch().catch((error) => {
  console.error('Failed to launch bot. Please check your BOT_TOKEN:', error);
  process.exit(1);
});
console.log('Bot started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));