/**
 * Automation Map — default spaces + sample workflow (ported from
 * lib/sampleWorkflow.ts). A small but complete "user authentication" example
 * shown on first open so the canvas is never empty.
 */

import { nanoid } from './dom.js';
import { makeNodeData } from './registry.js';

export const DEFAULT_SPACES = [
  { id: 'frontend', name: 'Frontend', color: '#38bdf8' },
  { id: 'backend', name: 'Backend', color: '#a78bfa' },
  { id: 'database', name: 'Database', color: '#34d399' },
  { id: 'ai-agents', name: 'AI Agents', color: '#f472b6' },
  { id: 'apis', name: 'APIs', color: '#22d3ee' },
  { id: 'bugs', name: 'Bugs', color: '#f87171' },
  { id: 'features', name: 'Features', color: '#fbbf24' },
  { id: 'deployment', name: 'Deployment', color: '#fb923c' },
  { id: 'documentation', name: 'Documentation', color: '#94a3b8' },
];

function node(kind, space, x, y, overrides) {
  return {
    id: nanoid(8),
    type: 'workflow',
    position: { x, y },
    data: { ...makeNodeData(kind, space), ...overrides },
  };
}

/** Build a fresh copy of the sample nodes + edges (new ids each call). */
export function buildSample() {
  const feature = node('feature', 'features', 0, 140, {
    title: 'User Authentication',
    description: 'Email + password login with JWT sessions.',
    status: 'in-progress',
    tags: ['auth', 'mvp'],
  });
  const reviewer = node('agent', 'ai-agents', 0, 360, {
    title: 'Spec Reviewer',
    description: 'AI agent that reviews the auth spec for gaps.',
    status: 'idea',
    prompt: 'Review this authentication flow for security gaps and missing edge cases.',
    tags: ['ai'],
  });
  const loginForm = node('file', 'frontend', 360, 0, {
    title: 'LoginForm.tsx',
    description: 'Login form UI with client-side validation.',
    status: 'planned',
    tags: ['react'],
  });
  const loginApi = node('api', 'apis', 360, 200, {
    title: 'POST /api/login',
    description: 'Authenticates a user and returns a JWT.',
    status: 'planned',
    url: 'https://api.example.com/login',
    tags: ['http'],
  });
  const jwtSecret = node('env', 'backend', 360, 420, {
    title: 'JWT_SECRET',
    description: 'Signing secret for tokens.',
    status: 'done',
    envVars: 'JWT_SECRET=replace-me',
  });
  const verify = node('function', 'backend', 720, 200, {
    title: 'verifyCredentials()',
    description: 'Checks the password hash and issues a token.',
    status: 'idea',
  });
  const usersDb = node('database', 'database', 1080, 120, {
    title: 'users table',
    description: 'Stores user accounts and hashed passwords.',
    status: 'planned',
    schema: 'id, email, password_hash, created_at',
    hasCredentials: true,
  });
  const authTest = node('test', 'deployment', 1080, 360, {
    title: 'auth.test.ts',
    description: 'Integration tests for the login flow.',
    status: 'needs-testing',
  });
  const deploy = node('deployment', 'deployment', 1440, 240, {
    title: 'Deploy to Vercel',
    description: 'Ship the authentication feature to production.',
    status: 'idea',
  });

  const nodes = [feature, reviewer, loginForm, loginApi, jwtSecret, verify, usersDb, authTest, deploy];

  const edge = (source, outIdx, target, inIdx, label, kind = 'default') => ({
    id: nanoid(8),
    source: source.id,
    target: target.id,
    sourceHandle: source.data.outputs[outIdx]?.id,
    targetHandle: target.data.inputs[inIdx]?.id,
    type: 'labeled',
    data: { label, kind },
  });

  const edges = [
    edge(feature, 0, loginForm, 0, 'builds'),
    edge(feature, 0, loginApi, 0, 'needs'),
    edge(reviewer, 0, loginApi, 0, 'reviewed', 'success'),
    edge(loginForm, 0, loginApi, 0, 'submits'),
    edge(loginApi, 0, verify, 0, 'on success', 'success'),
    edge(jwtSecret, 0, verify, 0, 'provides secret'),
    edge(verify, 0, usersDb, 0, 'reads / writes', 'success'),
    edge(usersDb, 0, authTest, 0, 'verify'),
    edge(authTest, 0, deploy, 0, 'passes', 'success'),
  ];

  return { nodes, edges, spaces: DEFAULT_SPACES.map((s) => ({ ...s })) };
}

/**
 * A runnable multi-agent pipeline shown by the empty-state "Load the sample
 * workflow" button: Input → Research Agent → Coding Agent → Test Agent →
 * Output, laid out left-to-right and pre-connected. Agents carry prompts so
 * the whole thing can be executed end-to-end with one "Run workflow".
 */
export function buildAgentPipelineSample() {
  const Y = 220;
  const input = node('feature', 'features', 0, Y, {
    title: 'Input',
    description: 'The task or request that flows into the pipeline.',
    status: 'idea',
    tags: ['input'],
  });
  const research = node('agent', 'ai-agents', 340, Y, {
    title: 'Research Agent',
    description: 'Gathers context and requirements for the task.',
    status: 'idea',
    systemPrompt: 'You are a meticulous research agent. Be concise and factual.',
    prompt: 'Research the task provided by the upstream Input node and summarise the key requirements, constraints and approach.',
    tags: ['ai'],
  });
  const coding = node('agent', 'ai-agents', 680, Y, {
    title: 'Coding Agent',
    description: 'Implements the solution from the research findings.',
    status: 'idea',
    systemPrompt: 'You are a senior software engineer. Produce clean, working code.',
    prompt: 'Using the research from the upstream node, implement the solution. Output the code clearly.',
    tags: ['ai'],
  });
  const testing = node('agent', 'ai-agents', 1020, Y, {
    title: 'Test Agent',
    description: 'Reviews and tests the generated code.',
    status: 'idea',
    systemPrompt: 'You are a rigorous QA engineer.',
    prompt: 'Review the code from the upstream Coding Agent. List bugs, edge cases and concrete test cases.',
    tags: ['ai'],
  });
  const output = node('documentation', 'documentation', 1360, Y, {
    title: 'Output',
    description: 'Final result / summary collected from the pipeline.',
    status: 'idea',
    tags: ['output'],
  });

  const nodes = [input, research, coding, testing, output];
  const edge = (source, outIdx, target, inIdx, label, kind = 'default') => ({
    id: nanoid(8),
    source: source.id,
    target: target.id,
    sourceHandle: source.data.outputs[outIdx]?.id,
    targetHandle: target.data.inputs[inIdx]?.id,
    type: 'labeled',
    data: { label, kind },
  });
  const edges = [
    edge(input, 0, research, 0, 'task'),
    edge(research, 0, coding, 0, 'findings', 'success'),
    edge(coding, 0, testing, 0, 'code', 'success'),
    edge(testing, 0, output, 0, 'result', 'success'),
  ];

  return { nodes, edges, spaces: DEFAULT_SPACES.map((s) => ({ ...s })) };
}
