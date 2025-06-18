require('dotenv').config();
const { Telegraf } = require('telegraf');
const { Low, JSONFile } = require('lowdb');
const fs = require('fs');
const path = require('path');

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

// Setup database
const adapter = new JSONFile('db.json');
const db = new Low(adapter);

async function initDB() {
  await db.read();
  db.data ||= { users: {} };
  await db.write();
}

function getUserData(ctx) {
  const id = String(ctx.chat.id);
  if (!db.data.users[id]) {
    db.data.users[id] = { needs: [], resources: [] };
  }
  return db.data.users[id];
}

(async () => {
  await initDB();

  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start(async (ctx) => {
    await db.read();
    getUserData(ctx);
    await db.write();
    await ctx.reply(t(ctx, 'welcome'));
  });

  bot.command('addneed', async (ctx) => {
    await db.read();
    const user = getUserData(ctx);
    const input = ctx.message.text.split(' ').slice(1).join(' ');
    if (!input) return ctx.reply(t(ctx, 'addNeedUsage'));
    user.needs.push(input);
    await db.write();
    ctx.reply(t(ctx, 'addNeedSuccess', { item: input }));
  });

  bot.command('listneeds', async (ctx) => {
    await db.read();
    const user = getUserData(ctx);
    if (user.needs.length === 0) return ctx.reply(t(ctx, 'noNeeds'));
    const list = user.needs.map((n, i) => `${i + 1}. ${n}`).join('\n');
    ctx.reply(t(ctx, 'listNeeds', { list }));
  });

  bot.command('deleteneed', async (ctx) => {
    await db.read();
    const user = getUserData(ctx);
    const arg = ctx.message.text.split(' ')[1];
    const index = parseInt(arg, 10);
    if (!arg || isNaN(index) || index < 1 || index > user.needs.length) {
      return ctx.reply(t(ctx, 'deleteNeedUsage'));
    }
    const removed = user.needs.splice(index - 1, 1)[0];
    await db.write();
    ctx.reply(t(ctx, 'deleteNeedSuccess', { item: removed }));
  });

  bot.command('addresource', async (ctx) => {
    await db.read();
    const user = getUserData(ctx);
    const input = ctx.message.text.split(' ').slice(1).join(' ');
    if (!input) return ctx.reply(t(ctx, 'addResourceUsage'));
    user.resources.push(input);
    await db.write();
    ctx.reply(t(ctx, 'addResourceSuccess', { item: input }));
  });

  bot.command('listresources', async (ctx) => {
    await db.read();
    const user = getUserData(ctx);
    if (user.resources.length === 0) return ctx.reply(t(ctx, 'noResources'));
    const list = user.resources.map((r, i) => `${i + 1}. ${r}`).join('\n');
    ctx.reply(t(ctx, 'listResources', { list }));
  });

  bot.command('deleteresource', async (ctx) => {
    await db.read();
    const user = getUserData(ctx);
    const arg = ctx.message.text.split(' ')[1];
    const index = parseInt(arg, 10);
    if (!arg || isNaN(index) || index < 1 || index > user.resources.length) {
      return ctx.reply(t(ctx, 'deleteResourceUsage'));
    }
    const removed = user.resources.splice(index - 1, 1)[0];
    await db.write();
    ctx.reply(t(ctx, 'deleteResourceSuccess', { item: removed }));
  });

  console.log('Launching bot...');
  const launchPromise = bot.launch();
  console.log('Bot started');
  launchPromise.catch((error) => {
    console.error('Failed to launch bot. Please check your BOT_TOKEN:', error);
    process.exit(1);
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})(); 