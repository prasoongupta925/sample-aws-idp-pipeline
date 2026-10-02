import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const bedrockClient = new BedrockRuntimeClient();

// Gemma 3 12B: AWS-sold and in-Region in ap-south-1 (no cross-Region profile).
export const SESSION_NAME_MODEL_ID = 'google.gemma-3-12b-it';

interface MessageContent {
  text?: string;
}

interface MessageData {
  message: {
    role: string;
    content: MessageContent[];
  };
  message_id: number;
  redact_message: unknown;
  created_at: string;
  updated_at: string;
}

function extractTextFromMessage(messageData: MessageData): string {
  const content = messageData.message?.content ?? [];
  return content
    .filter((item) => item.text)
    .map((item) => item.text as string)
    .join('\n');
}

/**
 * The title in a Converse answer: the first text block (a model may put
 * reasoning blocks first), its first line, without wrapping quotes or
 * Markdown emphasis. null when there is no title.
 */
export function sessionNameFromContent(
  content: { text?: string }[] | undefined,
): string | null {
  const text = content?.find((block) => typeof block.text === 'string')?.text;
  const firstLine = (text ?? '').trim().split('\n')[0] ?? '';
  const title = firstLine.replace(/^[\s"'“”*_#`]+|[\s"'“”*_#`]+$/g, '');
  return title || null;
}

export async function generateSessionName(
  s3Client: S3Client,
  bucket: string,
  messageKey: string,
): Promise<string | null> {
  const message0Key = messageKey.replace('message_1.json', 'message_0.json');

  const [userResponse, assistantResponse] = await Promise.all([
    s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: message0Key })),
    s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: messageKey })),
  ]);

  const userBody = await userResponse.Body?.transformToString();
  const assistantBody = await assistantResponse.Body?.transformToString();

  if (!userBody || !assistantBody) {
    return null;
  }

  const userData: MessageData = JSON.parse(userBody);
  const assistantData: MessageData = JSON.parse(assistantBody);

  const userText = extractTextFromMessage(userData).slice(0, 500);
  const assistantText = extractTextFromMessage(assistantData).slice(0, 500);

  const prompt = [
    'Generate a natural and descriptive session title based on the following conversation.',
    'The title should be 3-6 words that capture the essence or goal of the conversation.',
    'Make it sound like a natural conversation topic, not just keywords.',
    'Detect the language used in the conversation and write the title in that same language.',
    'Output only the title, nothing else.',
    '',
    `User: ${userText}`,
    '',
    `Assistant: ${assistantText}`,
  ].join('\n');

  const command = new ConverseCommand({
    modelId: SESSION_NAME_MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens: 50,
    },
  });

  const response = await bedrockClient.send(command);
  return sessionNameFromContent(response.output?.message?.content);
}
