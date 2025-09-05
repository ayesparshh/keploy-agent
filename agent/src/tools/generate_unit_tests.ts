import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Client } from 'pg';

export function createGenerateUnitTestsTool(workDir: string, sendMessage: (message: any) => void) {
  return tool({
    description: 'Generates unit tests for a Go file by finding relevant code examples using embeddings and vector search',
    inputSchema: z.object({
      filePath: z.string().describe('Path to the Go file relative to working directory that needs unit tests'),
      testFramework: z.enum(['testing', 'testify']).optional().describe('Go testing framework to use (default: testing)'),
      coverageTarget: z.number().min(0).max(100).optional().describe('Target test coverage percentage')
    }),
    execute: async ({ filePath, testFramework = 'testing', coverageTarget }) => {
      sendMessage({
        type: 'tool_call',
        data: { 
          toolName: 'generate_unit_tests', 
          args: { 
            filePath,
            testFramework,
            coverageTarget
          }
        }
      });
      
      const fullPath = path.resolve(workDir, filePath);
      console.error(`[Tool] Generating unit tests for: ${fullPath}`);
      
      try {
        // Validate that the file exists and is a Go file
        const fileStats = await fs.stat(fullPath);
        if (!fileStats.isFile()) {
          return { error: `Path is not a file: ${filePath}`, filePath };
        }
        
        if (!filePath.endsWith('.go')) {
          return { error: `File is not a Go file: ${filePath}`, filePath };
        }
        
        // Read the Go file content
        const content = await fs.readFile(fullPath, 'utf8');
        
        // Generate embedding for the code content
        const embedding = await generateEmbedding(content);
        
        // Search for similar code-test pairs in vector database
        const examples = await searchVectorDatabase(embedding);
        
        // Generate unit tests using AI with context from examples
        const testContent = await generateTests(content, examples, testFramework, coverageTarget);
        
        // Determine test file path (filename_test.go)
        const testFilePath = filePath.replace(/\.go$/, '_test.go');
        const fullTestPath = path.resolve(workDir, testFilePath);
        
        // Check if test file already exists
        let testFileExists = false;
        try {
          await fs.stat(fullTestPath);
          testFileExists = true;
        } catch (error) {
          // File doesn't exist, which is fine
        }
        
        // If test file exists, we need user permission to overwrite
        if (testFileExists) {
          sendMessage({
            type: 'response',
            data: {
              content: `⚠️ Test file ${testFilePath} already exists. This operation will overwrite the existing file.`,
              requiresUserConfirmation: true,
              operation: 'overwrite_test_file',
              filePath: testFilePath,
              fullPath: fullTestPath
            }
          });
          
          console.error(`[Tool] WARNING: Overwriting existing test file: ${fullTestPath}`);
        }
        
        // Write the generated tests to file
        await fs.writeFile(fullTestPath, testContent, 'utf8');
        
        // Execute tests and retry if they fail
        const testResults = await executeTestsWithRetry(
          workDir, 
          testFilePath, 
          content, 
          examples, 
          testFramework, 
          coverageTarget,
          sendMessage
        );
        
        return {
          filePath,
          testFilePath,
          testFramework,
          size: testContent.length,
          created: new Date().toISOString(),
          testResults
        };
      } catch (error: any) {
        return { error: error.message, filePath };
      }
    }
  });
}

async function generateEmbedding(content: string): Promise<number[]> {
  const embeddingServiceUrl = process.env.KEPLOY_EMBEDDING_SERVICE_URL;
  if (!embeddingServiceUrl) {
    throw new Error('KEPLOY_EMBEDDING_SERVICE_URL environment variable not set');
  }
  
  try {
    const response = await fetch(embeddingServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sentences: [content] })
    });
    
    if (!response.ok) {
      throw new Error(`Embedding service error: ${response.status} ${response.statusText}`);
    }
    
    const result = await response.json() as { embeddings?: number[][] };
    if (result.embeddings && result.embeddings.length > 0) {
      return result.embeddings[0]; // Return the first embedding since we sent one sentence
    }
    throw new Error('No embeddings returned from service');
  } catch (error: any) {
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

async function searchVectorDatabase(embedding: number[]): Promise<any[]> {
  const databaseUrl = process.env.KEPLOY_EMBED_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('KEPLOY_EMBED_DATABASE_URL environment variable not set');
  }
  
  const client = new Client({
    connectionString: databaseUrl
  });
  
  try {
    await client.connect();
    
    // Query for similar embeddings using the actual schema
    const query = `
      SELECT file_path, chunk_id, content, embedding <-> $1 as distance
      FROM code_embeddings
      ORDER BY embedding <-> $1
      LIMIT 10
    `;
    
    // Format the embedding array for PostgreSQL vector type
    const vectorString = `[${embedding.join(',')}]`;
    
    const res = await client.query(query, [vectorString]);
    return res.rows;
  } catch (error: any) {
    throw new Error(`Database search failed: ${error.message}`);
  } finally {
    await client.end();
  }
}

async function generateTests(
  codeContent: string, 
  examples: any[], 
  testFramework: string, 
  coverageTarget?: number
): Promise<string> {
  // Use AI model to generate tests based on code content and vector search examples
  const { generateText } = await import('ai');
  const { google } = await import('@ai-sdk/google');
  
  // Prepare context from vector search results
  const exampleContext = examples.map((ex, index) => 
    `Example ${index + 1} (similarity: ${(1 - ex.distance).toFixed(3)}):\n${ex.content}`
  ).join('\n\n');
  
  // Create AI prompt for test generation
  const systemPrompt = `You are an expert Go developer. Generate comprehensive unit tests for the provided Go code.

          Requirements:
          - Use the ${testFramework} testing framework
          - Target ${coverageTarget || 80}% test coverage
          - Write meaningful tests that cover edge cases, error conditions, and normal operation
          - Use the similar code examples as reference for testing patterns
          - Include proper test function names (TestFunctionName)
          - Add table-driven tests where appropriate
          - Test both success and failure scenarios
          - Include proper assertions and error checking

          CRITICAL: Generate ONLY the raw Go test code content. Do NOT include:
          - Markdown code block syntax (backticks with go or plain backticks)
          - Any explanations or comments outside the code
          - Any formatting other than pure Go code
          - Package declarations or import statements (they will be added automatically)

Return only the test functions and their content.`;

  const userPrompt = `Generate unit tests for this Go code:

\`\`\`go
${codeContent}
\`\`\`

Similar code examples from knowledge base:
\`\`\`
${exampleContext}
\`\`\`

Please generate comprehensive unit tests using ${testFramework} framework.`;

  try {
    const result = await generateText({
      model: google('gemini-2.5-flash'),
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ],
      temperature: 0.1, // Low temperature for consistent, focused output
    });
    
    // Clean the AI response to remove any markdown syntax
    let cleanTestContent = result.text.trim();
    
    // Remove markdown code block syntax if present
    cleanTestContent = cleanTestContent.replace(/^```go\s*/i, '');
    cleanTestContent = cleanTestContent.replace(/```\s*$/i, '');
    cleanTestContent = cleanTestContent.replace(/^```\s*/i, '');
    cleanTestContent = cleanTestContent.replace(/```\s*$/i, '');
    
    // Ensure we have proper package and import statements
    const importStatement = testFramework === 'testify' 
      ? 'import (\n  "testing"\n  "github.com/stretchr/testify/assert"\n)'
      : 'import (\n  "testing"\n)';
    
    // Construct the final test file
    const finalTestContent = `package main

${importStatement}

${cleanTestContent}
`;
    
    return finalTestContent;
  } catch (error: any) {
    console.error('[Tool] AI test generation failed:', error);
    
    // Fallback to basic template if AI fails
    const importStatement = testFramework === 'testify' 
      ? 'import (\n  "testing"\n  "github.com/stretchr/testify/assert"\n)'
      : 'import (\n  "testing"\n)';
    
    return `package main

${importStatement}

// AI test generation failed, using fallback template
// Vector search found ${examples.length} similar examples
// Error: ${error.message}

func TestPlaceholder(t *testing.T) {
  t.Skip("AI test generation failed - please implement tests manually")
}
`;
  }
}

async function executeTestsWithRetry(
  workDir: string,
  testFilePath: string,
  originalCode: string,
  examples: any[],
  testFramework: string,
  coverageTarget: number | undefined,
  sendMessage: (message: any) => void
): Promise<any> {
  const maxRetries = 3;
  let attempt = 1;
  let lastError: any = null;
  
  while (attempt <= maxRetries) {
    sendMessage({
      type: 'tool_call',
      data: { 
        toolName: 'run_command', 
        args: { 
          command: `go test -v ./${testFilePath}`,
          timeout: 30000
        }
      }
    });
    
    try {
      // Execute the tests
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout, stderr } = await execAsync(`go test -v ./${testFilePath}`, {
        cwd: workDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 10
      });
      
      // Check if tests passed by looking for "PASS" in output and no compilation errors
      const hasPass = stdout.includes('PASS') || stdout.includes('ok');
      const hasCompilationError = stderr.includes('undefined:') || 
                                 stderr.includes('redeclared') || 
                                 stderr.includes('unknown field') ||
                                 stderr.includes('too many errors') ||
                                 stderr.includes('syntax error');
      
      if (hasPass && !hasCompilationError) {
        sendMessage({
          type: 'response',
          data: {
            content: `✅ Tests passed on attempt ${attempt}!`,
            testOutput: stdout
          }
        });
        
        return {
          success: true,
          attempt,
          output: stdout,
          error: null
        };
      } else {
        // Tests failed - combine stdout and stderr for error message
        const fullError = `${stdout}\n${stderr}`.trim();
        throw new Error(`Tests failed: ${fullError}`);
      }
      
    } catch (error: any) {
      lastError = error;
      const errorMessage = error.stderr || error.message || 'Unknown test error';
      
      sendMessage({
        type: 'response',
        data: {
          content: `❌ Test attempt ${attempt} failed: ${errorMessage}`,
          testOutput: error.stdout || ''
        }
      });
      
      // If this is not the last attempt, regenerate tests
      if (attempt < maxRetries) {
        sendMessage({
          type: 'response',
          data: {
            content: `🔄 Regenerating tests (attempt ${attempt + 1}/${maxRetries})...`
          }
        });
        
        try {
          console.error(`[Tool] Regenerating tests for attempt ${attempt + 1} with error context: ${errorMessage.substring(0, 200)}...`);
          
          // Generate new tests with error context
          const newTestContent = await generateTestsWithErrorContext(
            originalCode, 
            examples, 
            testFramework, 
            coverageTarget,
            errorMessage,
            attempt
          );
          
          // Write the new test content
          const fullTestPath = path.resolve(workDir, testFilePath);
          console.error(`[Tool] Writing regenerated test content to: ${fullTestPath}`);
          await fs.writeFile(fullTestPath, newTestContent, 'utf8');
          
          sendMessage({
            type: 'response',
            data: {
              content: `✅ Test file regenerated successfully for attempt ${attempt + 1}`
            }
          });
          
        } catch (regenerateError: any) {
          console.error(`[Tool] Test regeneration failed:`, regenerateError);
          sendMessage({
            type: 'response',
            data: {
              content: `⚠️ Failed to regenerate tests: ${regenerateError.message}`
            }
          });
        }
      }
      
      attempt++;
    }
  }
  
  // All attempts failed
  sendMessage({
    type: 'response',
    data: {
      content: `❌ All ${maxRetries} test attempts failed. Final error: ${lastError?.message || 'Unknown error'}`
    }
  });
  
  return {
    success: false,
    attempts: maxRetries,
    finalError: lastError?.message || 'Unknown error',
    output: lastError?.stdout || ''
  };
}

async function generateTestsWithErrorContext(
  codeContent: string, 
  examples: any[], 
  testFramework: string, 
  coverageTarget: number | undefined,
  errorMessage: string,
  attempt: number
): Promise<string> {
  // Use AI model to generate tests based on code content and vector search examples
  const { generateText } = await import('ai');
  const { google } = await import('@ai-sdk/google');
  
  // Prepare context from vector search results
  const exampleContext = examples.map((ex, index) => 
    `Example ${index + 1} (similarity: ${(1 - ex.distance).toFixed(3)}):\n${ex.content}`
  ).join('\n\n');
  
  // Create AI prompt for test generation with error context
  const systemPrompt = `You are an expert Go developer. Generate comprehensive unit tests for the provided Go code.

Requirements:
- Use the ${testFramework} testing framework
- Target ${coverageTarget || 80}% test coverage
- Write meaningful tests that cover edge cases, error conditions, and normal operation
- Use the similar code examples as reference for testing patterns
- Include proper test function names (TestFunctionName)
- Add table-driven tests where appropriate
- Test both success and failure scenarios
- Include proper assertions and error checking

CRITICAL: Generate ONLY the raw Go test code content. Do NOT include:
- Markdown code block syntax (backticks with go or plain backticks)
- Any explanations or comments outside the code
- Any formatting other than pure Go code
- Package declarations or import statements (they will be added automatically)

Return only the test functions and their content.`;

  // Analyze the error to provide specific guidance
  let errorGuidance = '';
  if (errorMessage.includes('redeclared')) {
    errorGuidance = 'IMPORTANT: Fix duplicate import declarations. Make sure each import is only declared once.';
  } else if (errorMessage.includes('undefined:')) {
    errorGuidance = 'IMPORTANT: Fix undefined function/variable references. Make sure all functions and variables exist in the original code.';
  } else if (errorMessage.includes('unknown field')) {
    errorGuidance = 'IMPORTANT: Fix struct field names. Use the correct field names from the original struct definitions.';
  } else if (errorMessage.includes('syntax error')) {
    errorGuidance = 'IMPORTANT: Fix Go syntax errors. Ensure proper Go syntax and formatting.';
  } else {
    errorGuidance = 'IMPORTANT: Fix all compilation errors and ensure the test code is syntactically correct.';
  }

  const userPrompt = `Generate unit tests for this Go code (attempt ${attempt + 1}):

\`\`\`go
${codeContent}
\`\`\`

Similar code examples from knowledge base:
\`\`\`
${exampleContext}
\`\`\`

Previous test attempt failed with these errors:
${errorMessage}

${errorGuidance}

Please fix the issues and generate working unit tests using ${testFramework} framework.`;

  try {
    const result = await generateText({
      model: google('gemini-2.5-flash'),
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ],
      temperature: 0.1 // Low temperature for consistent, focused output
    });
    
    // Clean the AI response to remove any markdown syntax
    let cleanTestContent = result.text.trim();
    
    // Remove markdown code block syntax if present
    cleanTestContent = cleanTestContent.replace(/^```go\s*/i, '');
    cleanTestContent = cleanTestContent.replace(/```\s*$/i, '');
    cleanTestContent = cleanTestContent.replace(/^```\s*/i, '');
    cleanTestContent = cleanTestContent.replace(/```\s*$/i, '');
    
    // Ensure we have proper package and import statements
    const importStatement = testFramework === 'testify' 
      ? 'import (\n  "testing"\n  "github.com/stretchr/testify/assert"\n)'
      : 'import (\n  "testing"\n)';
    
    // Construct the final test file
    const finalTestContent = `package main

${importStatement}

${cleanTestContent}
`;
    
    return finalTestContent;
  } catch (error: any) {
    console.error('[Tool] AI test regeneration failed:', error);
    
    // Fallback to basic template if AI fails
    const importStatement = testFramework === 'testify' 
      ? 'import (\n  "testing"\n  "github.com/stretchr/testify/assert"\n)'
      : 'import (\n  "testing"\n)';
    
    return `package main

${importStatement}

// AI test regeneration failed, using fallback template
// Previous error: ${errorMessage}
// Attempt: ${attempt + 1}

func TestPlaceholder(t *testing.T) {
  t.Skip("AI test regeneration failed - please implement tests manually")
}
`;
  }
}