import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export function createEditFileTool(workDir: string, sendMessage: (message: any) => void) {
  return tool({
    description: 'Edit a file by replacing specific text or patterns',
    inputSchema: z.object({
      path: z.string().describe('Path to the file relative to working directory'),
      search: z.string().describe('Text or pattern to search for'),
      replace: z.string().describe('Text to replace with'),
      regex: z.boolean().default(false).describe('Treat search as a regular expression'),
      all: z.boolean().default(true).describe('Replace all occurrences')
    }),
    execute: async ({ path: filePath, search, replace, regex, all }) => {
      sendMessage({
        type: 'tool_call',
        data: { 
          toolName: 'edit_file', 
          args: { 
            path: filePath, 
            search: search.substring(0, 50), 
            replace: replace.substring(0, 50), 
            regex, 
            all 
          }
        }
      });
      
      const fullPath = path.resolve(workDir, filePath);
      console.error(`[Tool] Editing file: ${fullPath}`);
      
      try {
        let content = await fs.readFile(fullPath, 'utf8');
        const originalLength = content.length;
        
        if (regex) {
          const flags = all ? 'g' : '';
          const pattern = new RegExp(search, flags);
          content = content.replace(pattern, replace);
        } else {
          content = all 
            ? content.split(search).join(replace)
            : content.replace(search, replace);
        }
        
        await fs.writeFile(fullPath, content, 'utf8');
        
        return {
          path: filePath,
          originalSize: originalLength,
          newSize: content.length,
          sizeDiff: content.length - originalLength,
          modified: new Date().toISOString()
        };
      } catch (error: any) {
        return { error: error.message, path: filePath };
      }
    }
  });
}