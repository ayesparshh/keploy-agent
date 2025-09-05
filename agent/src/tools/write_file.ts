import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export function createWriteFileTool(workDir: string, sendMessage: (message: any) => void) {
  return tool({
    description: 'Write or create a file with specified content',
    inputSchema: z.object({
      path: z.string().describe('Path to the file relative to working directory'),
      content: z.string().describe('Content to write to the file'),
      createDirs: z.boolean().default(true).describe('Create parent directories if they don\'t exist')
    }),
    execute: async ({ path: filePath, content, createDirs }) => {
      sendMessage({
        type: 'tool_call',
        data: { toolName: 'write_file', args: { path: filePath, contentLength: content.length, createDirs } }
      });
      
      const fullPath = path.resolve(workDir, filePath);
      console.error(`[Tool] Writing file: ${fullPath}`);
      
      try {
        if (createDirs) {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
        }
        await fs.writeFile(fullPath, content, 'utf8');
        const stats = await fs.stat(fullPath);
        
        return {
          path: filePath,
          size: stats.size,
          created: stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString()
        };
      } catch (error: any) {
        return { error: error.message, path: filePath };
      }
    }
  });
}