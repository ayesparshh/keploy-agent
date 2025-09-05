import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createRunCommandTool(workDir: string, sendMessage: (message: any) => void) {
  return tool({
    description: 'Run a shell command in the working directory',
    inputSchema: z.object({
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().default(30000).describe('Command timeout in milliseconds')
    }),
    execute: async ({ command, timeout }) => {
      sendMessage({
        type: 'tool_call',
        data: { toolName: 'run_command', args: { command, timeout } }
      });
      
      console.error(`[Tool] Running command: ${command} in ${workDir}`);
      
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workDir,
          timeout,
          maxBuffer: 1024 * 1024 * 10
        });
        
        return {
          command,
          stdout: stdout.substring(0, 5000),
          stderr: stderr.substring(0, 5000),
          exitCode: 0,
          workingDirectory: workDir
        };
      } catch (error: any) {
        return {
          command,
          error: error.message,
          stdout: error.stdout?.substring(0, 5000) || '',
          stderr: error.stderr?.substring(0, 5000) || '',
          exitCode: error.code || 1,
          workingDirectory: workDir
        };
      }
    }
  });
}