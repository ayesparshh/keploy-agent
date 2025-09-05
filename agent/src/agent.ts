import { generateText, stepCountIs, ModelMessage } from 'ai';
import { google } from '@ai-sdk/google';
import {
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
  createEditFileTool,
  createSearchFilesTool,
  createRunCommandTool,
  createWebSearchTool,
  createUrlExtractTool,
  createGenerateUnitTestsTool
} from './tools';
import path from 'path';
import fs from 'fs';
// Message protocol between Keploy Agent and agent
interface Message {
  type: 'init' | 'chat' | 'error' | 'response' | 'tool_call' | 'stream_chunk';
  data?: any;
}

//read system prompt from file agent/SYSTEM_MAIN.md
const systemPrompt = fs.readFileSync(path.join(__dirname, '..', 'SYSTEM_MAIN.md'), 'utf8');

class CodingAgent {
  private model: any = null;
  private conversationHistory: ModelMessage[] = [];
  private workDir: string;

  constructor() {
    this.workDir = process.env.KEPLOY_WORK_DIR || process.cwd();
  }

  initialize(apiKey: string) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
    this.model = google('gemini-2.5-flash');
    this.conversationHistory = [];
  }

  //TODO take this out. I learned I can handle this with prepareStep.
  private async ensureFinalResponse(
    result: any,
    model: any,
    history: ModelMessage[]
  ): Promise<any> {
    if (result.finishReason === "stop" && result.stopReason === "other") {
      console.error("[Agent] Step limit reached, generating wrap-up response");
  
      this.sendMessage({
        type: "stream_chunk",
        data: { content: "", status: "wrapping_up" }
      });
  
      const wrapUp = await generateText({
        model,
        system: `You reached the tool call limit. Summarize progress for the user. Be detailed in explaining what you have done or learned so far. Then state what your intentded next steps are. Call the user Master Wayne.`,
        messages: [...history]
      });
  
      return {
        ...wrapUp,
        finishReason: "stop",
        stopReason: "other",
        meta: { wrapUp: true }
      };
    }
  
    return result;
  }
   

  async processMessage(userMessage: string): Promise<void> {
    if (!this.model) {
      this.sendMessage({
        type: 'error',
        data: { message: 'Agent not initialized. Please provide API key.' }
      });
      return;
    }

    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage
      });

      // Send initial acknowledgment
      this.sendMessage({
        type: 'stream_chunk',
        data: { content: '', status: 'thinking' }
      });

      // Store reference for closures
      const agent = this;

      // Generate response with tools
      const MAX_STEPS = 25;
      const result = await generateText({
        model: this.model,
        system: systemPrompt + ` \n\n Current working directory: ${this.workDir}`,
        messages: this.conversationHistory,
        stopWhen: stepCountIs(MAX_STEPS),
        prepareStep: ({ stepNumber, messages }) => {
          if (stepNumber === MAX_STEPS-1) {
            return {
              toolChoice: 'none',
              activeTools: [],
              messages: [
                ...messages,
                {
                  role: 'system',
                  content:
                    "You have reached the maximum number of tool calls. Stop using tools now. " +
                    "Give the user a clear update on what you've done, what you learned, and what you would do next."
                }
              ]
            };
          }
          return undefined;
        },
        tools: {
          list_files: createListFilesTool(this.workDir, agent.sendMessage.bind(agent)),
          read_file: createReadFileTool(this.workDir, agent.sendMessage.bind(agent)),
          write_file: createWriteFileTool(this.workDir, agent.sendMessage.bind(agent)),
          edit_file: createEditFileTool(this.workDir, agent.sendMessage.bind(agent)),
          search_files: createSearchFilesTool(this.workDir, agent.sendMessage.bind(agent)),
          run_command: createRunCommandTool(this.workDir, agent.sendMessage.bind(agent)),
          web_search: createWebSearchTool(agent.sendMessage.bind(agent)),
          url_extract: createUrlExtractTool(agent.sendMessage.bind(agent)),
          generate_unit_tests: createGenerateUnitTestsTool(this.workDir, agent.sendMessage.bind(agent))
        },
        onStepFinish: async ({ text, finishReason }) => {
          if (text) {
            this.sendMessage({
              type: 'stream_chunk',
              data: {
                content: text,
                status: finishReason === 'stop' ? 'done' : 'generating'
              }
            });
          }
        }
      });

      // Ensure we have a final response, handling step limits
      const finalResult = await this.ensureFinalResponse(result, this.model, this.conversationHistory);

      // Add assistant response to history
      this.conversationHistory.push({
        role: 'assistant',
        content: finalResult.text
      });

      // Send final response
      this.sendMessage({
        type: 'response',
        data: {
          content: finalResult.text,
          toolCalls: finalResult.toolCalls,
          usage: finalResult.usage,
          finishReason: finalResult.finishReason,
          stopReason: finalResult.stopReason,
          messageCount: this.conversationHistory.length
        }
      });

    } catch (error: any) {
      console.error('[Agent] Error:', error);
      this.sendMessage({
        type: 'error',
        data: { 
          message: error.message || 'An error occurred while processing your request',
          details: error.toString()
        }
      });
    }
  }

  private sendMessage(message: Message) {
    console.log(JSON.stringify(message));
  }

  clearHistory() {
    this.conversationHistory = [];
    console.error('[Agent] Conversation history cleared');
  }
}

// Main entry point - stdio communication with Keploy Agent
async function main() {
  const agent = new CodingAgent();
  
  process.stdin.setEncoding('utf8');
  
  let buffer = '';
  
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;
    
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const message: Message = JSON.parse(line);
          
          switch (message.type) {
            case 'init':
              if (message.data?.apiKey) {
                agent.initialize(message.data.apiKey);
                agent['sendMessage']({
                  type: 'response',
                  data: { status: 'initialized', message: 'Agent initialized successfully' }
                });
              } else {
                agent['sendMessage']({
                  type: 'error',
                  data: { message: 'API key required for initialization' }
                });
              }
              break;
              
            case 'chat':
              if (message.data?.message) {
                await agent.processMessage(message.data.message);
              }
              break;
              

              
            default:
              agent['sendMessage']({
                type: 'error',
                data: { message: `Unknown message type: ${message.type}` }
              });
          }
        } catch (error: any) {
          console.error('[Agent] Error parsing message:', error);
          agent['sendMessage']({
            type: 'error',
            data: { message: 'Invalid message format', details: error.toString() }
          });
        }
      }
    }
  });
  
  process.stdin.on('end', () => {
    process.exit(0);
  });
  
  process.on('uncaughtException', (error) => {
    console.error('[Agent] Uncaught exception:', error);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Agent] Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}

main().catch(error => {
  console.error('[Agent] Fatal error:', error);
  process.exit(1);
});