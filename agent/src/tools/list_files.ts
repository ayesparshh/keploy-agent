import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export function createListFilesTool(workDir: string, sendMessage: (message: any) => void) {
  return tool({
    description: 'List files and directories in a given path',
    inputSchema: z.object({
      path: z.string().default('.').describe('Directory path relative to working directory'),
      recursive: z.boolean().default(false).describe('List files recursively')
    }),
    execute: async ({ path: dirPath, recursive }) => {
      // Send tool call notification
      sendMessage({
        type: 'tool_call',
        data: { toolName: 'list_files', args: { path: dirPath, recursive } }
      });
      
      const fullPath = path.resolve(workDir, dirPath);
      console.error(`[Tool] Listing files in: ${fullPath}`);
      
      try {
        if (recursive) {
          const files: string[] = [];
          const walk = async (dir: string): Promise<void> => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const entryPath = path.join(dir, entry.name);
              const relativePath = path.relative(workDir, entryPath);
              if (entry.isDirectory()) {
                if (!['node_modules', '.git'].includes(entry.name)) {
                  files.push(relativePath + '/');
                  await walk(entryPath);
                }
              } else {
                files.push(relativePath);
              }
            }
          };
          await walk(fullPath);
          return { path: dirPath, files, count: files.length };
        } else {
          const entries = await fs.readdir(fullPath, { withFileTypes: true });
          const files = entries.map(entry => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file'
          }));
          return { path: dirPath, files, count: files.length };
        }
      } catch (error: any) {
        return { error: error.message, path: dirPath };
      }
    }
  });
}