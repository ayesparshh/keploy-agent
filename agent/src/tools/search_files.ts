import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export function createSearchFilesTool(workDir: string, sendMessage: (message: any) => void) {
  const matchPattern = (name: string, pattern: string): boolean => {
    if (!pattern) return true;
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      return name.endsWith(pattern.substring(1));
    }
    return name.includes(pattern);
  };

  return tool({
    description: 'Search for files containing specific text or matching patterns',
    inputSchema: z.object({
      pattern: z.string().describe('Text or regex pattern to search for'),
      directory: z.string().default('.').describe('Directory to search in'),
      filePattern: z.string().optional().describe('File name pattern (e.g., "*.ts", "*.js")'),
      regex: z.boolean().default(false).describe('Treat pattern as regex')
    }),
    execute: async ({ pattern, directory, filePattern, regex }) => {
      sendMessage({
        type: 'tool_call',
        data: { toolName: 'search_files', args: { pattern, directory, filePattern, regex } }
      });
      
      const fullPath = path.resolve(workDir, directory);
      console.error(`[Tool] Searching for "${pattern}" in ${fullPath}`);
      
      try {
        const matches: Array<{ file: string; line: number; content: string }> = [];
        
        const searchInFile = async (filePath: string): Promise<void> => {
          try {
            const content = await fs.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            const searchPattern = regex ? new RegExp(pattern, 'gi') : pattern;
            
            lines.forEach((line, index) => {
              const found = regex 
                ? (searchPattern as RegExp).test(line)
                : line.toLowerCase().includes((searchPattern as string).toLowerCase());
                
              if (found) {
                matches.push({
                  file: path.relative(workDir, filePath),
                  line: index + 1,
                  content: line.trim()
                });
              }
            });
          } catch {
            // Skip files that can't be read
          }
        };
        
        const walk = async (dir: string): Promise<void> => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
              if (!['node_modules', '.git'].includes(entry.name)) {
                await walk(fullPath);
              }
            } else if (entry.isFile()) {
              if (!filePattern || matchPattern(entry.name, filePattern)) {
                await searchInFile(fullPath);
              }
            }
          }
        };
        
        await walk(fullPath);
        
        return {
          pattern,
          directory,
          matchCount: matches.length,
          matches: matches.slice(0, 100)
        };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  });
}