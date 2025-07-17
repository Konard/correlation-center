// Test script to verify bot system message detection
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load localization files (same as in index.js)
const locales = {
  en: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales/en.json'))),
  ru: JSON.parse(fs.readFileSync(path.join(__dirname, 'locales/ru.json'))),
};

// Copy the helper functions from index.js
function getAllBotMessageVariants() {
  const variants = new Set();
  for (const lang of Object.keys(locales)) {
    if (locales[lang].messages) {
      for (const key of Object.keys(locales[lang].messages)) {
        variants.add(locales[lang].messages[key]);
      }
    }
  }
  return Array.from(variants);
}

function isBotSystemMessage(msg, botId) {
  if (!msg || !msg.from || msg.from.id !== botId) return false;
  if (!msg.text) return false;
  const variants = getAllBotMessageVariants();
  return variants.some(variant => msg.text.trim().startsWith(variant.trim()));
}

// Test cases
function testBotSystemMessageDetection() {
  console.log('Testing bot system message detection...\n');
  
  const variants = getAllBotMessageVariants();
  console.log('Bot message variants found:');
  variants.forEach((variant, index) => {
    console.log(`${index + 1}. "${variant}"`);
  });
  console.log('\n');
  
  // Test cases - using actual bot message content
  const testCases = [
    {
      name: 'Help message content (English)',
      text: 'Available commands:\n/start - Start the bot\n/help - Show this help message\n/need - Add a need\n/needs - List your needs\n/resource - Add a resource\n/resources - List your resources\n/cancel - Cancel current pending action',
      expected: true
    },
    {
      name: 'Help message content (Russian)',
      text: 'Доступные команды:\n/start - Запустить бота\n/help - Показать это сообщение\n/need - Добавить потребность\n/needs - Показать ваши потребности\n/resource - Добавить ресурс\n/resources - Показать ваши ресурсы\n/cancel - Отменить текущее действие',
      expected: true
    },
    {
      name: 'Welcome message content (English)',
      text: 'Welcome to Correlation Center Bot!\n\nThe Correlation Center is a system inspired by Jacque Fresco ideas. It ensures that all needs are satisfied using available resources. In short, it\'s a system to manage needs and resources.\n\nType /help to see all commands.\n\nUse the keyboard below for quick access.',
      expected: true
    },
    {
      name: 'Welcome message content (Russian)',
      text: 'Добро пожаловать в бот Корреляционный Центр!\n\nКорреляционный Центр — это система, вдохновлённая идеями Жака Фреско. Она обеспечивает удовлетворение всех потребностей с помощью доступных ресурсов. Проще говоря, это система для управления потребностями и ресурсами.\n\nНапишите /help чтобы увидеть все команды.\n\nИспользуйте клавиатуру ниже для быстрого доступа.',
      expected: true
    },
    {
      name: 'Regular user message',
      text: 'I need a laptop for work',
      expected: false
    },
    {
      name: 'Prompt message (English)',
      text: 'Please send the description of your need as your next message.',
      expected: true
    },
    {
      name: 'Prompt message (Russian)',
      text: 'Пожалуйста, отправьте описание вашей потребности следующим сообщением.',
      expected: true
    }
  ];
  
  console.log('Running test cases:');
  testCases.forEach((testCase, index) => {
    const variants = getAllBotMessageVariants();
    const isSystemMessage = variants.some(variant => 
      testCase.text.trim().startsWith(variant.trim())
    );
    
    const result = isSystemMessage === testCase.expected ? 'PASS' : 'FAIL';
    console.log(`${index + 1}. ${testCase.name}: ${result}`);
    if (isSystemMessage !== testCase.expected) {
      console.log(`   Expected: ${testCase.expected}, Got: ${isSystemMessage}`);
      // Show which variant matched (if any)
      const matchingVariant = variants.find(variant => 
        testCase.text.trim().startsWith(variant.trim())
      );
      if (matchingVariant) {
        console.log(`   Matched variant: "${matchingVariant}"`);
      }
    }
  });
  
  console.log('\nTest completed!');
}

testBotSystemMessageDetection(); 