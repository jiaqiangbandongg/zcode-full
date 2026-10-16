import { createAnthropic } from '@ai-sdk/anthropic';

const client = createAnthropic({
  apiKey: process.env.ZCODE_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/anthropic',
});

const result = await client('glm-4.7').generateText({
  prompt: 'say hello in 3 words',
});

console.log('Result:', result);
