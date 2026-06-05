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
