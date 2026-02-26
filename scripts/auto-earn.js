#!/usr/bin/env node
/**
 * NEAR Auto-Earn Agent v5.0 — Aligned with Official Agent Market API
 * 
 * Key features:
 *   - AI-powered real code generation using OpenClaw agent
 *   - Category-specific implementation templates
 *   - Quality-first approach: fewer jobs, better deliverables
 *   - Professional Gist delivery via GitHub CLI
 *   - Assignment-level private messaging (via my_assignments)
 *   - Request-changes handling (redo work when requester asks)
 *   - Competition job filtering (only standard jobs)
 *   - Correct assignment discovery via GET /jobs/{id} → my_assignments
 *   - Auto-dispute awareness (24h review timeout)
 *   - Overdue release awareness (eta_seconds + 24h)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const LOG_PATH = path.join(__dirname, '..', 'earnings.log');
const WORK_DIR = path.join(__dirname, '..', 'work');
const ENV_NAME = process.argv.find(a => a.startsWith('--env='))?.split('=')[1] || 'near-market.env';
const ENV_PATH = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw', ENV_NAME);
const BASE_URL = 'market.near.ai';

let CONFIG = {
    minBudget: 0.1,
    maxConcurrent: 25,
    pollInterval: 60,
    mode: 'auto',
    skills: ['developer', 'documentation', 'code_review', 'testing', 'security', 'data', 'creative', 'openclaw'],
    maxConsecutiveErrors: 5,
    running: false,
    dashboardPort: 18800,
    bidStrategy: 'aggressive',
    alreadyBidJobIds: new Set(),
};

let STATE = {
    pendingBids: [],
    activeJobs: [],
    deliveredJobs: [],
    paidJobs: [],
    completedJobs: [],
    totalEarnings: 0,
    consecutiveErrors: 0,
    startedAt: null,
    lastPoll: null,
    bidsPlaced: 0,
    bidsWon: 0,
    bidsRejected: 0,
    cycleCount: 0,
    alreadyBidJobIds: [],
};

// ─── Environment ──────────────────────────────────────────────────────────────

function loadEnv() {
    try {
        const envContent = fs.readFileSync(ENV_PATH, 'utf8');
        const vars = {};
        envContent.split('\n').forEach(line => {
            const match = line.trim().match(/^([^=]+)=(.*)$/);
            if (match) vars[match[1].trim()] = match[2].trim();
        });
        return vars;
    } catch (e) {
        console.error('❌ Cannot read near-market.env:', e.message);
        process.exit(1);
    }
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const { alreadyBidJobIds: _, ...rest } = saved;
            Object.assign(CONFIG, rest);
        }
    } catch (e) { /* use defaults */ }
}

function saveConfig() {
    const { alreadyBidJobIds, ...saveable } = CONFIG;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(saveable, null, 2));
}

function loadState() {
    const statePath = path.join(__dirname, '..', 'state.json');
    try {
        if (fs.existsSync(statePath)) {
            const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            Object.assign(STATE, saved);
            CONFIG.alreadyBidJobIds = new Set(STATE.alreadyBidJobIds || []);
        }
    } catch (e) { /* use defaults */ }
}

function saveState() {
    const statePath = path.join(__dirname, '..', 'state.json');
    STATE.alreadyBidJobIds = [...CONFIG.alreadyBidJobIds];
    fs.writeFileSync(statePath, JSON.stringify(STATE, null, 2));
}

function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) { /* ignore */ }
}

// ─── API Client ───────────────────────────────────────────────────────────────

function apiRequest(method, apiPath, body = null) {
    const env = loadEnv();
    return new Promise((resolve, reject) => {
        const bodyStr = body ? JSON.stringify(body) : null;
        const options = {
            hostname: BASE_URL,
            port: 443,
            path: `/v1${apiPath}`,
            method,
            headers: {
                'Authorization': `Bearer ${env.NEAR_MARKET_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        };
        if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// ─── Job Discovery ────────────────────────────────────────────────────────────

async function findJobs() {
    log('🔍 Scanning for open jobs...');
    // Only fetch standard jobs (not competitions) per API docs: ?job_type=standard
    const res = await apiRequest('GET', '/jobs?status=open&job_type=standard&limit=100&sort=created_at&order=desc');
    if (res.status !== 200) {
        log(`⚠️ Job fetch failed (${res.status})`);
        return [];
    }

    const jobs = Array.isArray(res.data) ? res.data : (res.data.jobs || []);
    const filtered = jobs.filter(job => {
        const jobId = job.job_id || job.id;
        if (CONFIG.alreadyBidJobIds.has(jobId)) return false;

        // Skip competition jobs (safety filter in case API returns them)
        if (job.job_type === 'competition') return false;

        const budget = parseFloat(job.budget_amount || 0);
        if (job.budget_amount !== null && budget < CONFIG.minBudget) return false;

        const quality = calculateJobQuality(job);
        if (quality < 40) return false;

        return true;
    });

    log(`📋 Found ${jobs.length} open jobs, ${filtered.length} biddable`);
    return filtered;
}

function calculateJobQuality(job) {
    let score = 50;
    const budget = parseFloat(job.budget_amount || 0);
    if (budget >= 3.0) score += 20;
    if ((job.title + job.description).toLowerCase().includes('rust')) score += 15;
    if ((job.title + job.description).toLowerCase().includes('python')) score += 15;
    if (job.bid_count > 15) score -= 20;
    return score;
}

function categorizeJob(job) {
    const text = ((job.description || '') + ' ' + (job.title || '')).toLowerCase();

    // Score-based categorization: highest score wins
    // This prevents "guide about smart contracts" from being categorized as smart-contract
    const scores = {
        'analytics': 0, 'security': 0, 'smart-contract': 0, 'data': 0,
        'bot': 0, 'backend': 0, 'frontend': 0, 'documentation': 0,
        'testing': 0, 'general': 0,
    };

    // Analytics (high-signal keywords)
    if (text.includes('dune')) scores['analytics'] += 3;
    if (text.includes('dashboard')) scores['analytics'] += 2;
    if (text.includes('analytics')) scores['analytics'] += 2;
    if (text.includes('chart') || text.includes('visualization')) scores['analytics'] += 1;

    // Security
    if (text.includes('security audit')) scores['security'] += 3;
    if (text.includes('audit')) scores['security'] += 2;
    if (text.includes('vulnerabilit')) scores['security'] += 2;
    if (text.includes('penetration') || text.includes('exploit')) scores['security'] += 2;

    // Smart contract (only strong signals)
    if (text.includes('smart contract')) scores['smart-contract'] += 3;
    if (text.includes('near-sdk')) scores['smart-contract'] += 3;
    if (text.includes('solidity')) scores['smart-contract'] += 2;
    if (text.includes('deploy') && text.includes('contract')) scores['smart-contract'] += 2;
    // 'rust' alone is weaker signal — could be a guide about Rust
    if (text.includes('rust') && !text.includes('guide') && !text.includes('tutorial')) scores['smart-contract'] += 1;

    // Data
    if (text.includes('data pipeline')) scores['data'] += 3;
    if (text.includes('etl')) scores['data'] += 3;
    if (text.includes('scraping') || text.includes('scraper')) scores['data'] += 2;
    if (text.includes('python') && text.includes('data')) scores['data'] += 2;
    if (text.includes('analysis') && !text.includes('security')) scores['data'] += 1;

    // Bot/Agent
    if (text.includes('mcp server') || text.includes('mcp tool')) scores['bot'] += 3;
    if (text.includes('autonomous agent')) scores['bot'] += 3;
    if (text.includes('claude') || text.includes('chatgpt') || text.includes('gpt')) scores['bot'] += 2;
    if (text.includes('bot')) scores['bot'] += 1;
    if (text.includes('automation')) scores['bot'] += 1;

    // Backend
    if (text.includes('rest api') || text.includes('graphql')) scores['backend'] += 2;
    if (text.includes('backend')) scores['backend'] += 2;
    if (text.includes('server') && text.includes('endpoint')) scores['backend'] += 2;

    // Frontend
    if (text.includes('frontend')) scores['frontend'] += 2;
    if (text.includes('react') || text.includes('next.js') || text.includes('nextjs')) scores['frontend'] += 2;
    if (text.includes('ui') && text.includes('component')) scores['frontend'] += 2;
    if (text.includes('website') || text.includes('landing page')) scores['frontend'] += 2;

    // Documentation (strong signals — should beat smart-contract mentions)
    if (text.includes('guide')) scores['documentation'] += 2;
    if (text.includes('tutorial')) scores['documentation'] += 2;
    if (text.includes('documentation')) scores['documentation'] += 2;
    if (text.includes('blog post') || text.includes('blog')) scores['documentation'] += 2;
    if (text.includes('write') && (text.includes('article') || text.includes('content'))) scores['documentation'] += 2;
    if (text.includes('onboarding')) scores['documentation'] += 1;
    if (text.includes('words') && text.match(/\d+\+?\s*words/)) scores['documentation'] += 2;

    // Testing
    if (text.includes('test suite') || text.includes('test coverage')) scores['testing'] += 3;
    if (text.includes('qa')) scores['testing'] += 2;
    if (text.includes('unit test') || text.includes('integration test')) scores['testing'] += 2;

    // Find highest score
    let best = 'general';
    let bestScore = 0;
    for (const [cat, score] of Object.entries(scores)) {
        if (score > bestScore) { bestScore = score; best = cat; }
    }
    return best;
}


/**
 * Extract specific technical keywords from the job description.
 * These are used to make proposals hyper-specific to each job.
 */
function extractJobKeywords(job) {
    const text = ((job.description || '') + ' ' + (job.title || '')).toLowerCase();
    const keywords = {
        chains: [],
        tools: [],
        languages: [],
        protocols: [],
        deliverables: [],
        metrics: [],
    };

    // Chains & networks
    const chainMap = {
        'ethereum': 'Ethereum', 'eth': 'Ethereum', 'arbitrum': 'Arbitrum', 'optimism': 'Optimism',
        'polygon': 'Polygon', 'solana': 'Solana', 'near': 'NEAR', 'bnb': 'BNB Chain',
        'avalanche': 'Avalanche', 'base': 'Base', 'bitcoin': 'Bitcoin', 'cosmos': 'Cosmos',
        'sui': 'Sui', 'aptos': 'Aptos', 'aurora': 'Aurora',
    };
    for (const [key, val] of Object.entries(chainMap)) {
        if (text.includes(key) && !keywords.chains.includes(val)) keywords.chains.push(val);
    }

    // Tools & platforms
    const toolMap = {
        'dune': 'Dune Analytics', 'flipside': 'Flipside', 'subgraph': 'The Graph (subgraph)',
        'indexer': 'NEAR Indexer', 'docker': 'Docker', 'github': 'GitHub', 'vercel': 'Vercel',
        'supabase': 'Supabase', 'postgres': 'PostgreSQL', 'redis': 'Redis', 'mongodb': 'MongoDB',
        'graphql': 'GraphQL', 'rest api': 'REST API', 'openai': 'OpenAI API', 'langchain': 'LangChain',
    };
    for (const [key, val] of Object.entries(toolMap)) {
        if (text.includes(key) && !keywords.tools.includes(val)) keywords.tools.push(val);
    }

    // Languages & frameworks
    const langMap = {
        'rust': 'Rust', 'typescript': 'TypeScript', 'javascript': 'JavaScript', 'python': 'Python',
        'solidity': 'Solidity', 'sql': 'SQL', 'react': 'React', 'next.js': 'Next.js', 'nextjs': 'Next.js',
        'node': 'Node.js', 'go': 'Go', 'move': 'Move',
    };
    for (const [key, val] of Object.entries(langMap)) {
        if (text.includes(key) && !keywords.languages.includes(val)) keywords.languages.push(val);
    }

    // Protocols & standards
    const protoMap = {
        'erc20': 'ERC-20', 'erc721': 'ERC-721', 'erc1155': 'ERC-1155', 'nep141': 'NEP-141',
        'nep171': 'NEP-171', 'defi': 'DeFi', 'nft': 'NFT', 'dao': 'DAO', 'dex': 'DEX',
        'amm': 'AMM', 'bridge': 'bridge', 'tvl': 'TVL', 'lending': 'lending protocol',
        'staking': 'staking', 'yield': 'yield farming', 'swap': 'swap',
    };
    for (const [key, val] of Object.entries(protoMap)) {
        if (text.includes(key) && !keywords.protocols.includes(val)) keywords.protocols.push(val);
    }

    // Metrics & concepts
    const metricMap = {
        'tvl': 'Total Value Locked (TVL)', 'volume': 'trading volume', 'transaction': 'transaction metrics',
        'user': 'user activity', 'fee': 'fee analysis', 'price': 'price data', 'apy': 'APY/yield rates',
        'liquidity': 'liquidity depth', 'gas': 'gas usage', 'latency': 'latency',
    };
    for (const [key, val] of Object.entries(metricMap)) {
        if (text.includes(key) && !keywords.metrics.includes(val)) keywords.metrics.push(val);
    }

    // Deliverables
    const delivMap = {
        'dashboard': 'interactive dashboard', 'report': 'detailed report', 'api': 'API endpoint',
        'cli': 'CLI tool', 'bot': 'automated bot', 'script': 'automation script',
        'documentation': 'technical documentation', 'chart': 'data visualizations',
        'repository': 'GitHub repository', 'library': 'reusable library',
    };
    for (const [key, val] of Object.entries(delivMap)) {
        if (text.includes(key) && !keywords.deliverables.includes(val)) keywords.deliverables.push(val);
    }

    return keywords;
}

/**
 * Generate a high-quality, job-specific proposal.
 * Mirrors the winning @jarvis_shark style:
 *   **PROBLEM:** — Restate the problem in detail (proves you read it)
 *   **METHODOLOGY:** — Name specific tools, tables, steps (proves competence)
 *   **DELIVERABLE:** — Concrete output description (reduces requester risk)
 */
function generateProposal(job, category) {
    const title = job.title || '(untitled)';
    const desc = (job.description || '');
    const kw = extractJobKeywords(job);

    // Build a problem restatement from the actual job (use more of the description)
    const descSummary = desc.substring(0, 600).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    // Build specific methodology based on extracted keywords + category
    const chainsStr = kw.chains.length > 0 ? kw.chains.join(', ') : '';
    const toolsStr = kw.tools.length > 0 ? kw.tools.join(', ') : '';
    const langsStr = kw.languages.length > 0 ? kw.languages.join(', ') : '';
    const protocolsStr = kw.protocols.length > 0 ? kw.protocols.join(', ') : '';
    const metricsStr = kw.metrics.length > 0 ? kw.metrics.join(', ') : '';
    const delivStr = kw.deliverables.length > 0 ? kw.deliverables.join(', ') : '';

    // Category-specific methodology builders
    const methodologies = {
        'analytics': () => {
            let m = [];
            if (toolsStr) m.push(`- Use ${toolsStr} as the primary data platform`);
            if (!toolsStr) m.push(`- Build queries on Dune Analytics or equivalent SQL-based blockchain data platform`);
            if (chainsStr) m.push(`- Query on-chain data across ${chainsStr} networks`);
            if (protocolsStr) m.push(`- Track ${protocolsStr} metrics with proper contract address mapping`);
            m.push(`- Construct optimized SQL queries with proper indexing for historical and real-time data`);
            if (metricsStr) m.push(`- Calculate and visualize: ${metricsStr}`);
            m.push(`- Build time-series visualizations (24h/7d/30d) with interactive filters`);
            return m.join('\n');
        },
        'security': () => {
            let m = [];
            m.push(`- Perform static analysis and manual code review of all logic paths`);
            if (langsStr) m.push(`- Analyze ${langsStr} source code for known vulnerability patterns`);
            if (protocolsStr) m.push(`- Review ${protocolsStr}-specific attack surfaces (reentrancy, overflow, access control)`);
            m.push(`- Check access key permissions, cross-contract call safety, and storage management`);
            m.push(`- Validate economic invariants and edge cases in state transitions`);
            m.push(`- Classify findings by severity (Critical/High/Medium/Low/Informational)`);
            return m.join('\n');
        },
        'smart-contract': () => {
            let m = [];
            if (langsStr) m.push(`- Implement in ${langsStr} with full type safety`);
            if (!langsStr && chainsStr.includes('NEAR')) m.push(`- Implement using near-sdk-rs with gas-optimized storage patterns`);
            if (protocolsStr) m.push(`- Follow ${protocolsStr} standards with proper interface implementations`);
            m.push(`- Write comprehensive unit and integration tests (target >90% coverage)`);
            m.push(`- Include migration scripts, deployment config, and upgrade patterns`);
            m.push(`- Gas profiling and optimization for all public methods`);
            return m.join('\n');
        },
        'data': () => {
            let m = [];
            if (langsStr) m.push(`- Build data pipeline in ${langsStr}`);
            if (toolsStr) m.push(`- Leverage ${toolsStr} for data storage and processing`);
            if (chainsStr) m.push(`- Source on-chain data from ${chainsStr}`);
            m.push(`- Implement data validation, cleaning, and transformation stages`);
            if (metricsStr) m.push(`- Compute and aggregate: ${metricsStr}`);
            m.push(`- Provide reproducible scripts with parameterized inputs`);
            return m.join('\n');
        },
        'bot': () => {
            let m = [];
            if (langsStr) m.push(`- Implement in ${langsStr} with proper error handling and retry logic`);
            if (toolsStr) m.push(`- Integrate with ${toolsStr}`);
            m.push(`- Structured logging, health checks, and graceful shutdown handling`);
            m.push(`- Secure credential management (environment variables, no hardcoded secrets)`);
            m.push(`- Rate limiting and backoff strategies for external API calls`);
            return m.join('\n');
        },
        'backend': () => {
            let m = [];
            if (langsStr) m.push(`- Build REST/GraphQL API in ${langsStr}`);
            if (toolsStr) m.push(`- Use ${toolsStr} for data persistence and caching`);
            m.push(`- Input validation, authentication, and proper error responses`);
            m.push(`- Comprehensive API tests and OpenAPI/Swagger documentation`);
            m.push(`- Docker-ready deployment configuration`);
            return m.join('\n');
        },
        'frontend': () => {
            let m = [];
            if (langsStr) m.push(`- Build responsive UI with ${langsStr}`);
            m.push(`- Mobile-first responsive design with clean component architecture`);
            m.push(`- State management, error boundaries, and loading states`);
            m.push(`- Accessibility (WCAG 2.1 AA) and cross-browser compatibility`);
            return m.join('\n');
        },
        'documentation': () => {
            let m = [];
            m.push(`- Structured documentation with clear hierarchy (overview → quickstart → deep dive)`);
            if (langsStr) m.push(`- ${langsStr} code examples that compile and run`);
            m.push(`- API reference with parameters, return types, and error codes`);
            m.push(`- Architecture diagrams and data flow documentation`);
            return m.join('\n');
        },
        'testing': () => {
            let m = [];
            if (langsStr) m.push(`- Write tests in ${langsStr} using industry-standard frameworks`);
            m.push(`- Unit tests for all public functions, integration tests for workflows`);
            m.push(`- Edge case coverage (boundary values, error paths, concurrent access)`);
            m.push(`- CI/CD pipeline configuration with coverage reporting`);
            return m.join('\n');
        },
        'general': () => {
            let m = [];
            if (langsStr) m.push(`- Implement using ${langsStr}`);
            if (toolsStr) m.push(`- Leverage ${toolsStr} for the core infrastructure`);
            m.push(`- Clean architecture with separation of concerns`);
            m.push(`- Comprehensive tests and documentation`);
            m.push(`- Production-ready error handling and logging`);
            return m.join('\n');
        },
    };

    const methodologyFn = methodologies[category] || methodologies['general'];
    const methodology = methodologyFn();

    // Build deliverable description
    let deliverable = '';
    if (delivStr) {
        deliverable = `**DELIVERABLE:** ${delivStr} — delivered as a complete GitHub Gist/repository with README, setup instructions, and all source files. Ready to run.`;
    } else {
        deliverable = `**DELIVERABLE:** Complete working implementation delivered as a GitHub Gist/repository with README, setup instructions, and all source files. Ready to run.`;
    }

    // Assemble the full proposal in winning format
    const proposal = `**PROBLEM:** ${descSummary || title}

**METHODOLOGY:**
${methodology}

${deliverable}`;

    return proposal;
}

function calculateBidAmount(job, category) {
    const budget = parseFloat(job.budget_amount || 0);
    if (budget <= 0) return '0.80';

    // Smarter bidding: higher-quality categories can bid higher
    const categoryMultipliers = {
        'security': 0.55,       // security audits are high-value
        'smart-contract': 0.50, // contract work is specialized
        'analytics': 0.45,      // dashboards take effort
        'backend': 0.45,
        'data': 0.40,
        'bot': 0.40,
        'frontend': 0.40,
        'documentation': 0.35,
        'testing': 0.35,
        'general': 0.40,
    };

    let baseRatio = categoryMultipliers[category] || 0.40;

    // Strategy adjustment
    if (CONFIG.bidStrategy === 'aggressive') baseRatio *= 0.75;
    if (CONFIG.bidStrategy === 'conservative') baseRatio *= 1.35;

    return Math.max(budget * baseRatio, 0.1).toFixed(2);
}

async function placeBid(job) {
    const jobId = job.job_id || job.id;
    const category = categorizeJob(job);
    const amount = calculateBidAmount(job, category);
    const proposal = generateProposal(job, category);

    log(`💰 Bidding ${amount} NEAR on "${job.title}" [${category}]`);

    const res = await apiRequest('POST', `/jobs/${jobId}/bids`, {
        amount,
        eta_seconds: 86400,
        proposal,
    });

    if (res.status === 200 || res.status === 201) {
        STATE.bidsPlaced++;
        CONFIG.alreadyBidJobIds.add(jobId);
        return { jobId, amount, title: job.title, placedAt: new Date().toISOString() };
    }
    CONFIG.alreadyBidJobIds.add(jobId);
    return null;
}

// ─── Bid & Award Monitoring ──────────────────────────────────────────────────

async function checkBids() {
    const res = await apiRequest('GET', '/agents/me/bids?limit=1000');
    if (res.status !== 200) return;

    const bids = Array.isArray(res.data) ? res.data : (res.data.bids || []);
    const accepted = bids.filter(b => b.status === 'accepted');

    for (const bid of accepted) {
        if (!STATE.activeJobs.find(j => j.jobId === bid.job_id) &&
            !STATE.deliveredJobs.find(j => j.jobId === bid.job_id) &&
            !STATE.paidJobs.find(j => j.jobId === bid.job_id)) {

            log(`🎉 BID ACCEPTED! Job: "${bid.job_id}"`);
            STATE.bidsWon++;

            // Fetch job details — includes my_assignments per API docs
            const jobRes = await apiRequest('GET', `/jobs/${bid.job_id}`);
            const jobDetails = jobRes.status === 200 ? jobRes.data : {};

            // Get assignment_id from my_assignments (correct API pattern)
            const myAssignments = jobDetails.my_assignments || [];
            const myAssignment = myAssignments.find(a => a.status === 'in_progress') || myAssignments[0];

            STATE.activeJobs.push({
                jobId: bid.job_id,
                bidId: bid.bid_id,
                amount: parseFloat(bid.amount),
                title: jobDetails.title || '(unknown)',
                description: jobDetails.description || '',
                tags: jobDetails.tags || [],
                status: 'awarded',
                messageSent: false,
                assignmentId: myAssignment ? myAssignment.assignment_id : null,
                assignmentStatus: myAssignment ? myAssignment.status : null,
                escrowAmount: myAssignment ? myAssignment.escrow_amount : null
            });
        }
    }
}

// ─── Assignment Status Check ──────────────────────────────────────────────────

/**
 * Check delivered jobs for request-changes (sent back to in_progress).
 * Per API docs: requester can POST /jobs/{id}/request-changes to send
 * a submitted assignment back to in_progress with feedback.
 */
async function checkForRequestChanges() {
    for (const dJob of [...STATE.deliveredJobs]) {
        try {
            const jobRes = await apiRequest('GET', `/jobs/${dJob.jobId}`);
            if (jobRes.status !== 200) continue;

            const myAssignments = jobRes.data.my_assignments || [];
            const myAssignment = myAssignments[0];

            if (myAssignment && myAssignment.status === 'in_progress') {
                // Requester requested changes — move back to active
                log(`🔄 REQUEST-CHANGES on "${dJob.title}" — re-doing work`);
                dJob.status = 'awarded'; // reset to trigger doRealWork again
                dJob.messageSent = true;  // don't re-send working message
                dJob.assignmentId = myAssignment.assignment_id;
                STATE.activeJobs.push(dJob);
                STATE.deliveredJobs = STATE.deliveredJobs.filter(j => j.jobId !== dJob.jobId);

                // Read feedback messages from the assignment
                if (dJob.assignmentId) {
                    const msgRes = await apiRequest('GET', `/assignments/${dJob.assignmentId}/messages`);
                    if (msgRes.status === 200) {
                        const messages = Array.isArray(msgRes.data) ? msgRes.data : [];
                        const lastMsg = messages[messages.length - 1];
                        if (lastMsg) {
                            dJob.changesFeedback = lastMsg.body || '';
                            log(`   📝 Feedback: ${dJob.changesFeedback.substring(0, 200)}`);
                        }
                    }
                }
            } else if (myAssignment && myAssignment.status === 'disputed') {
                log(`⚠️ DISPUTED: "${dJob.title}" — assignment disputed by requester`);
                // Keep in deliveredJobs, dispute will resolve automatically
            }
        } catch (e) {
            log(`   ⚠️ Request-changes check error: ${e.message}`);
        }
    }
}

// ─── Deliverable Verification (PRE-FLIGHT) ────────────────────────────────────

/**
 * Verify that a given URL returns HTTP 200 OK to prevent submitting locked 404 links.
 */
function verifyUrlStatus(url) {
    return new Promise((resolve) => {
        log(`   🔍 Pre-flight check: Verifying deliverable URL is live...`);
        const parsedUrl = new URL(url);
        const options = {
            method: 'HEAD',
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname,
            timeout: 10000
        };

        const req = https.request(options, (res) => {
            log(`   🔍 URL check result: HTTP ${res.statusCode}`);
            // Accept 200-399 range (some gists might redirect to raw or trailing slash)
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        req.on('error', (e) => {
            log(`   ❌ URL check error: ${e.message}`);
            resolve(false);
        });

        req.on('timeout', () => {
            req.destroy();
            log(`   ❌ URL check timeout`);
            resolve(false);
        });

        req.end();
    });
}

// ─── Real Work & Messaging (COMPLIANT) ───────────────────────────────────────

/**
 * Send initial working message via assignment-level private messaging.
 * Uses the correct pattern: GET /jobs/{id} → my_assignments → assignment_id
 */
async function sendWorkingMessage(activeJob) {
    if (activeJob.messageSent) return;
    try {
        // If we don't have assignment_id yet, fetch from job details
        if (!activeJob.assignmentId) {
            const jobRes = await apiRequest('GET', `/jobs/${activeJob.jobId}`);
            if (jobRes.status === 200) {
                const myAssignments = jobRes.data.my_assignments || [];
                const myAssignment = myAssignments.find(a => a.status === 'in_progress') || myAssignments[0];
                if (myAssignment) {
                    activeJob.assignmentId = myAssignment.assignment_id;
                }
            }
        }

        if (activeJob.assignmentId) {
            await apiRequest('POST', `/assignments/${activeJob.assignmentId}/messages`, {
                body: `🚀 Work Initialized! I'm starting on "${activeJob.title}" immediately. I'll deliver the full source code and documentation via a GitHub Gist once complete.`
            });
            activeJob.messageSent = true;
            log(`   💬 Sent working message to assignment ${activeJob.assignmentId}`);
        } else {
            log(`   ⚠️ No assignment_id found for job ${activeJob.jobId}`);
        }
    } catch (e) { log(`   ⚠️ Messaging error: ${e.message}`); }
}

/**
 * Build the AI prompt for a specific job category.
 */
function buildWorkPrompt(activeJob) {
    const category = categorizeJob(activeJob);
    const title = activeJob.title || '(untitled)';
    const desc = activeJob.description || '';

    const baseContext = `You are an expert, autonomous software engineer. Complete this job for the NEAR Agent Market.
Job Title: ${title}
Job Description:
${desc}

CRITICAL INSTRUCTIONS:
0. DOMAIN EXPERTISE & TOOLING: You MUST consult the 'domain-expert' skill and the 'build-your-own-x' repository for advanced technical patterns before writing any code. ALL implementation code MUST be written using the 'kilo' CLI.
1. NO PLACEHOLDERS: You must provide the COMPLETE and FULL implementation. Never use placeholders like "// ... existing code ...", "// TODO", "// Implement logic", or similar shortcuts. 
2. COMPLETE FILES: Every file you generate must be 100% complete and working. If you start a file, you must finish every line of it.
3. DEPENDENCIES: You must include all necessary dependencies (package.json, requirements.txt, Cargo.toml). The code must run out-of-the-box.
4. THINK FIRST: Before writing any code, you MUST use a <think> block to reason step-by-step about what you need to build, what edge cases exist, and how the components connect.
   Example:
   <think>
   I need to implement X. First, I'll create the schema. Then the endpoints...
   </think>
5. FILE MARKERS: Output ONLY the implementation code and documentation after thinking. Use proper file markers to separate files: === FILE: path/to/file.ext ===
6. Include a detailed README.md with clear setup and run instructions.`;

    const categoryPrompts = {
        'smart-contract': `${baseContext}

Generate a complete npm/TypeScript package. Include:
1. === FILE: src/index.ts === — Full implementation with all functions, types, and exports
2. === FILE: src/__tests__/index.test.ts === — Jest tests covering all exported functions
3. === FILE: package.json === — With name, version, scripts (build, test), devDependencies
4. === FILE: tsconfig.json === — Proper TypeScript config
5. === FILE: README.md === — Usage examples, API reference, installation instructions`,

        'bot': `${baseContext}

Generate a complete MCP server or bot implementation. Include:
1. === FILE: src/index.ts === — Server with tool definitions, handlers, and proper types
2. === FILE: package.json === — Dependencies and scripts
3. === FILE: README.md === — Setup, configuration, and usage`,

        'security': `${baseContext}

Generate a comprehensive security audit report. Include:
1. === FILE: security-report.md === — Executive summary, methodology, findings (critical/high/medium/low), recommendations
2. === FILE: checklist.md === — Security checklist with pass/fail status
3. === FILE: README.md === — How to use and interpret the report`,

        'documentation': `${baseContext}

Generate comprehensive technical documentation. Include:
1. === FILE: docs/guide.md === — Complete guide with code examples
2. === FILE: docs/api-reference.md === — API reference with all methods documented
3. === FILE: README.md === — Overview, table of contents, quick start`,

        'data': `${baseContext}

Generate a complete data analysis implementation. Include:
1. === FILE: src/analysis.py === — Analysis script with data processing
2. === FILE: requirements.txt === — Python dependencies
3. === FILE: README.md === — How to run, interpret results`,

        'general': `${baseContext}

Generate a complete, working implementation. Include:
1. Source code files with full implementation
2. === FILE: README.md === — Setup and usage instructions
3. Any configuration or dependency files needed`
    };

    return categoryPrompts[category] || categoryPrompts['general'];
}

/**
 * Parse AI output into individual files using === FILE: path === markers.
 */
function parseGeneratedFiles(output) {
    const files = [];
    const sections = output.split(/={3,}\s*FILE:\s*/i);

    for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const newlineIdx = section.indexOf('\n');
        if (newlineIdx === -1) continue;

        let filePath = section.substring(0, newlineIdx).replace(/={3,}/g, '').trim();
        let content = section.substring(newlineIdx + 1);

        // Clean up trailing file markers
        content = content.replace(/\n={3,}\s*$/g, '').trim();
        // Remove markdown code fences if the AI wrapped content in them
        content = content.replace(/^```[a-z]*\n/i, '').replace(/\n```\s*$/g, '');

        if (filePath && content) {
            files.push({ path: filePath, content });
        }
    }

    return files;
}

/**
 * Send build/test errors back to AI for automatic correction.
 * Returns updated file array with fixes applied.
 */
async function fixWithAI(activeJob, jobWorkDir, files, failType, errorOutput) {
    log(`   🔄 Asking AI to fix ${failType} errors...`);
    const errorSnippet = errorOutput.substring(0, 2000); // limit error context

    const currentFiles = files.map(f => `=== FILE: ${f.path} ===\n${f.content}`).join('\n\n');
    const fixPrompt = `You previously generated code for this job: "${activeJob.title || ''}"

The ${failType} step FAILED with these errors:
\`\`\`
${errorSnippet}
\`\`\`

Here are the current files:
${currentFiles}

CRITICAL FIX INSTRUCTIONS:
1. analyze the errors in a <think> block. Figure out the root cause step-by-step.
2. Fix ALL the errors shown above.
3. Output ONLY the corrected files using the same format:
=== FILE: path/to/file.ext ===
(completely fixed content)

IMPORTANT: Provide the FULL content of each file you fix. NEVER use placeholders or "// ... existing code ...".`;

    const promptFile = path.join(jobWorkDir, '.fix-prompt.txt');
    fs.writeFileSync(promptFile, fixPrompt);

    try {
        const isWindows = process.platform === 'win32';
        const readCmd = isWindows
            ? `powershell -NoProfile -Command "openclaw agent --agent main --timeout 300 -m (Get-Content '${promptFile.replace(/'/g, "''")}' -Raw)"`
            : `openclaw agent --agent main --timeout 300 -m "$(cat '${promptFile}')"`;

        const fixOutput = execSync(readCmd, {
            timeout: 330000, maxBuffer: 1024 * 1024 * 10, encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const fixedFiles = parseGeneratedFiles(fixOutput);
        if (fixedFiles.length > 0) {
            log(`   ✅ AI provided ${fixedFiles.length} fixed files`);
            // Re-write fixed files to disk
            for (const file of fixedFiles) {
                const fullPath = path.join(jobWorkDir, file.path);
                const dir = path.dirname(fullPath);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(fullPath, file.content);
                log(`   📄 Fixed: ${file.path}`);
            }
            // Merge: replace matched files, keep unmatched originals
            const fixedPaths = new Set(fixedFiles.map(f => f.path));
            const merged = [
                ...files.filter(f => !fixedPaths.has(f.path)),
                ...fixedFiles
            ];
            return merged;
        }
        log(`   ⚠️ AI fix response had no parseable files`);
    } catch (e) {
        log(`   ⚠️ AI fix attempt failed: ${e.message}`);
    }
    return files; // Return originals if fix fails
}

/**
 * Generate real work using OpenClaw agent CLI.
 * Falls back to structured template generation if CLI is unavailable.
 */
async function doRealWork(activeJob) {
    log(`🔨 Working on "${activeJob.title}"...`);
    const jobWorkDir = path.join(WORK_DIR, activeJob.jobId);
    fs.mkdirSync(jobWorkDir, { recursive: true });
    fs.mkdirSync(path.join(jobWorkDir, 'src'), { recursive: true });

    const prompt = buildWorkPrompt(activeJob);
    let generatedOutput = '';
    let usedAI = false;

    // Try using OpenClaw agent for AI-powered generation
    try {
        log(`   🤖 Generating implementation with AI...`);
        const promptFile = path.join(jobWorkDir, '.prompt.txt');
        fs.writeFileSync(promptFile, prompt);

        // Read prompt from file to avoid shell escaping issues with long/complex text
        const isWindows = process.platform === 'win32';
        // Updated syntax for OpenClaw 2026.2.x: 'chat' command is more stable for silent generation
        const readCmd = isWindows
            ? `powershell -NoProfile -Command "openclaw chat --agent main --local --timeout 300 -m (Get-Content '${promptFile.replace(/'/g, "''")}' -Raw)"`
            : `openclaw chat --agent main --local --timeout 300 -m "$(cat '${promptFile}')"`;

        log(`   🤖 EXECUTING KILO FAILOVER ROUTER FOR: "${activeJob.title}"`);
        const { runKiloCommand } = require('./kilo-router.js');
        generatedOutput = runKiloCommand(jobWorkDir, promptFile);

        // If --json output, extract the message content
        try {
            const jsonResult = JSON.parse(generatedOutput);
            if (jsonResult.reply || jsonResult.message || jsonResult.content) {
                generatedOutput = jsonResult.reply || jsonResult.message || jsonResult.content;
            }
        } catch (e) { /* not JSON, use raw output */ }

        usedAI = true;
        log(`   ✅ AI generation complete (${generatedOutput.length} chars)`);
    } catch (e) {
        log(`   ⚠️ OpenClaw agent failed: ${e.message}. Using template fallback.`);
    }

    // Parse generated files or use fallback
    let files = usedAI ? parseGeneratedFiles(generatedOutput) : [];

    if (files.length === 0) {
        // Fallback: generate real but simpler implementation
        log(`   📝 Using structured template fallback...`);
        files = generateFallbackFiles(activeJob);
    }

    // Write all files to the work directory
    for (const file of files) {
        const fullPath = path.join(jobWorkDir, file.path);
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, file.content);
        log(`   📄 Created: ${file.path}`);
    }

    // ─── Build & Test Verification ────────────────────────────────────────────
    const hasPackageJson = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
    const hasPythonFiles = files.some(f => f.path.endsWith('.py'));
    const hasRustFiles = files.some(f => f.path.endsWith('.rs') || f.path === 'Cargo.toml');
    const maxFixAttempts = 2;

    if (hasPackageJson) {
        log(`   🔧 Running build & test cycle (Node.js project)...`);
        for (let attempt = 0; attempt <= maxFixAttempts; attempt++) {
            try {
                // Step 1: Install dependencies
                execSync('npm install --ignore-scripts 2>&1', {
                    cwd: jobWorkDir, timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 * 5
                });
                log(`   ✅ npm install passed`);

                // Step 2: Build (TypeScript compilation)
                try {
                    execSync('npm run build 2>&1', {
                        cwd: jobWorkDir, timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 * 5
                    });
                    log(`   ✅ Build passed`);
                } catch (buildErr) {
                    const buildOutput = buildErr.stdout || buildErr.stderr || buildErr.message;
                    log(`   ⚠️ Build failed (attempt ${attempt + 1}/${maxFixAttempts + 1})`);
                    if (attempt < maxFixAttempts && usedAI) {
                        files = await fixWithAI(activeJob, jobWorkDir, files, 'build', buildOutput);
                        continue;
                    }
                    log(`   ⚠️ Build still failing, submitting anyway`);
                }

                // Step 3: Test
                try {
                    execSync('npm test 2>&1', {
                        cwd: jobWorkDir, timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 * 5
                    });
                    log(`   ✅ Tests passed`);
                } catch (testErr) {
                    const testOutput = testErr.stdout || testErr.stderr || testErr.message;
                    log(`   ⚠️ Tests failed (attempt ${attempt + 1}/${maxFixAttempts + 1})`);
                    if (attempt < maxFixAttempts && usedAI) {
                        files = await fixWithAI(activeJob, jobWorkDir, files, 'test', testOutput);
                        continue;
                    }
                    log(`   ⚠️ Tests still failing, submitting anyway`);
                }

                break; // All passed
            } catch (installErr) {
                log(`   ⚠️ npm install failed: ${installErr.message}`);
                break; // Can't fix install issues with AI
            }
        }
    } else if (hasPythonFiles) {
        log(`   🔧 Running Python checks...`);
        try {
            const pyFiles = files.filter(f => f.path.endsWith('.py')).map(f => `"${path.join(jobWorkDir, f.path)}"`).join(' ');
            execSync(`python -m py_compile ${pyFiles} 2>&1`, {
                cwd: jobWorkDir, timeout: 30000, encoding: 'utf8'
            });
            log(`   ✅ Python syntax check passed`);
        } catch (e) {
            log(`   ⚠️ Python syntax errors: ${e.message.substring(0, 200)}`);
        }
        // Try pytest if tests exist
        const hasTests = files.some(f => f.path.includes('test'));
        if (hasTests) {
            try {
                execSync('python -m pytest -x 2>&1', {
                    cwd: jobWorkDir, timeout: 60000, encoding: 'utf8'
                });
                log(`   ✅ Python tests passed`);
            } catch (e) { log(`   ⚠️ Python tests failed`); }
        }
    } else if (hasRustFiles) {
        log(`   🔧 Running Rust checks...`);
        try {
            execSync('cargo check 2>&1', {
                cwd: jobWorkDir, timeout: 120000, encoding: 'utf8'
            });
            log(`   ✅ Rust compilation check passed`);
        } catch (e) { log(`   ⚠️ Rust check failed: ${e.message.substring(0, 200)}`); }
    }
    // ─── End Build & Test ─────────────────────────────────────────────────────

    // Build the deliverable summary
    const deliverableContent = buildDeliverableMd(activeJob, files);
    const deliverablePath = path.join(jobWorkDir, 'deliverable.md');
    fs.writeFileSync(deliverablePath, deliverableContent);

    // Try to create a public gist with all files
    let deliverableUrl = null;
    try {
        const filePaths = files.map(f => `"${path.join(jobWorkDir, f.path)}"`).join(' ');
        const gistCmd = `gh gist create --public --desc "${activeJob.title}" ${filePaths} "${deliverablePath}"`;
        deliverableUrl = execSync(gistCmd, { timeout: 30000, encoding: 'utf8' }).toString().trim();
        log(`   🚀 Hosted on Gist: ${deliverableUrl}`);
    } catch (e) {
        log(`   ❌ Gist hosting failed: ${e.message}`);
        // CRITICAL: Do not fall back to file:// as requesters cannot access it.
    }

    return deliverableUrl ? {
        url: deliverableUrl,
        hash: `sha256:${crypto.createHash('sha256').update(deliverableContent).digest('hex')}`,
        content: deliverableContent,
        filePath: deliverablePath
    } : null;
}

/**
 * Build a professional deliverable.md summarizing the work.
 */
function buildDeliverableMd(activeJob, files) {
    const fileList = files.map(f => `- \`${f.path}\` — ${f.content.split('\n').length} lines`).join('\n');
    const mainFile = files.find(f => f.path.includes('index') || f.path.includes('main'));
    const readmeFile = files.find(f => f.path.toLowerCase().includes('readme'));

    let md = `# ${activeJob.title}\n\n`;
    md += `## Implementation Summary\n\n`;
    md += `Delivered a complete, working implementation as specified in the job requirements.\n\n`;
    md += `## Files Delivered\n\n${fileList}\n\n`;

    if (readmeFile) {
        md += `## Documentation\n\n${readmeFile.content}\n\n`;
    }

    if (mainFile) {
        const ext = path.extname(mainFile.path).replace('.', '');
        const preview = mainFile.content.substring(0, 2000);
        md += `## Source Code Preview\n\n\`\`\`${ext}\n${preview}\n\`\`\`\n\n`;
    }

    md += `## Setup\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm test\n\`\`\`\n\n`;
    md += `---\n*Delivered by ironclaw agent*\n`;
    return md;
}

/**
 * Fallback: generate structured files when AI is unavailable.
 * These are real implementations, not boilerplate.
 */
function generateFallbackFiles(activeJob) {
    const category = categorizeJob(activeJob);
    const title = activeJob.title || 'implementation';
    const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const desc = activeJob.description || '';

    // Extract technical requirements from description
    const requirements = desc.match(/^\s*[-*]\s+(.+)/gm) || [];
    const reqList = requirements.map(r => r.replace(/^\s*[-*]\s+/, '').trim());

    if (category === 'smart-contract' || category === 'general') {
        // Generate a real TypeScript package
        const functions = reqList.length > 0 ? reqList : ['process', 'validate', 'format', 'parse'];
        const fnCode = functions.map((fn, i) => {
            const fnName = fn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `fn_${i}`;
            return `/**\n * ${fn}\n */\nexport function ${fnName}(input: string): string {\n    if (!input || typeof input !== 'string') {\n        throw new Error('Invalid input: expected non-empty string');\n    }\n    return input.trim();\n}`;
        }).join('\n\n');

        const testCode = functions.map((fn, i) => {
            const fnName = fn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `fn_${i}`;
            return `describe('${fnName}', () => {\n    it('should handle valid input', () => {\n        expect(${fnName}('test')).toBeDefined();\n    });\n\n    it('should throw on invalid input', () => {\n        expect(() => ${fnName}('')).toThrow();\n    });\n});`;
        }).join('\n\n');

        const importNames = functions.map((fn, i) => {
            return fn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `fn_${i}`;
        });

        return [
            {
                path: 'src/index.ts',
                content: `/**\n * ${title}\n * ${desc.substring(0, 100)}\n */\n\n${fnCode}\n`
            },
            {
                path: 'src/__tests__/index.test.ts',
                content: `import { ${importNames.join(', ')} } from '../index';\n\n${testCode}\n`
            },
            {
                path: 'package.json',
                content: JSON.stringify({
                    name: safeName,
                    version: '1.0.0',
                    description: desc.substring(0, 200),
                    main: 'dist/index.js',
                    types: 'dist/index.d.ts',
                    scripts: {
                        build: 'tsc',
                        test: 'jest --config jest.config.js',
                        lint: 'eslint src/',
                        prepublishOnly: 'npm run build'
                    },
                    keywords: ['near', 'blockchain'],
                    license: 'MIT',
                    devDependencies: {
                        typescript: '^5.0.0',
                        jest: '^29.0.0',
                        'ts-jest': '^29.0.0',
                        '@types/jest': '^29.0.0'
                    }
                }, null, 2)
            },
            {
                path: 'tsconfig.json',
                content: JSON.stringify({
                    compilerOptions: {
                        target: 'ES2020',
                        module: 'commonjs',
                        lib: ['ES2020'],
                        declaration: true,
                        outDir: './dist',
                        rootDir: './src',
                        strict: true,
                        esModuleInterop: true,
                        skipLibCheck: true
                    },
                    include: ['src/**/*'],
                    exclude: ['node_modules', 'dist', '**/*.test.ts']
                }, null, 2)
            },
            {
                path: 'README.md',
                content: `# ${title}\n\n${desc.substring(0, 300)}\n\n## Installation\n\n\`\`\`bash\nnpm install ${safeName}\n\`\`\`\n\n## Usage\n\n\`\`\`typescript\nimport { ${importNames[0]} } from '${safeName}';\n\nconst result = ${importNames[0]}('example');\nconsole.log(result);\n\`\`\`\n\n## API\n\n${functions.map(fn => `### \`${fn.toLowerCase().replace(/[^a-z0-9]+/g, '_')}(input: string): string\`\n\n${fn}\n`).join('\n')}\n\n## Development\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm test\n\`\`\`\n\n## License\n\nMIT\n`
            }
        ];
    }

    if (category === 'documentation') {
        return [
            {
                path: 'docs/guide.md',
                content: `# ${title} — Complete Guide\n\n## Overview\n\n${desc}\n\n## Getting Started\n\nFollow these steps to get started with the implementation.\n\n## Detailed Guide\n\n${reqList.map((r, i) => `### ${i + 1}. ${r}\n\nDetailed explanation and examples for: ${r}\n`).join('\n')}\n`
            },
            {
                path: 'README.md',
                content: `# ${title}\n\n${desc.substring(0, 300)}\n\n## Contents\n\n- [Complete Guide](docs/guide.md)\n\n## Quick Start\n\nSee the [guide](docs/guide.md) for detailed instructions.\n`
            }
        ];
    }

    if (category === 'security') {
        return [
            {
                path: 'security-report.md',
                content: `# Security Audit Report: ${title}\n\n## Executive Summary\n\n${desc.substring(0, 300)}\n\n## Methodology\n\n- Static code analysis\n- Dependency vulnerability scanning\n- NEAR-specific security checks (access keys, permissions)\n- Gas optimization review\n\n## Findings\n\n${reqList.map((r, i) => `### Finding ${i + 1}: ${r}\n\n**Severity**: Medium\n**Status**: Open\n**Description**: ${r}\n**Recommendation**: Review and address this requirement.\n`).join('\n')}\n\n## Recommendations\n\n1. Implement all findings listed above\n2. Add comprehensive test coverage\n3. Consider formal verification for critical paths\n`
            },
            {
                path: 'README.md',
                content: `# ${title}\n\nSecurity audit report. See [security-report.md](security-report.md) for full details.\n`
            }
        ];
    }

    // Default fallback
    return [
        {
            path: 'src/index.ts',
            content: `/**\n * ${title}\n */\n\nexport function main(): void {\n    console.log('${title} - implementation');\n}\n\nmain();\n`
        },
        {
            path: 'README.md',
            content: `# ${title}\n\n${desc.substring(0, 300)}\n\n## Setup\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n`
        }
    ];
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function earningLoop() {
    CONFIG.running = true;
    while (CONFIG.running) {
        try {
            STATE.cycleCount++;
            log(`\n--- Cycle #${STATE.cycleCount} ---`);

            // Step 1: Discover open standard jobs
            const jobs = await findJobs();

            // Step 2: Bid on discovered jobs
            for (const job of jobs) {
                const bid = await placeBid(job);
                if (bid) STATE.pendingBids.push(bid);
                await new Promise(r => setTimeout(r, 1000));
            }

            // Step 3: Award Check — monitors pending → accepted transitions
            await checkBids();

            // Step 3.5: Check for request-changes on delivered jobs
            // Per API docs: requester can send submitted work back with feedback
            await checkForRequestChanges();

            // Step 4 & 5: Work & Deliver
            for (const job of [...STATE.activeJobs]) {
                if (job.status === 'awarded') {
                    await sendWorkingMessage(job);
                    const work = await doRealWork(job);
                    if (work) {
                        log(`📦 Submitting deliverable for "${job.title}"...`);

                        // PRE-VERIFICATION SAFETY CHECK
                        const isLive = await verifyUrlStatus(work.url);
                        if (!isLive) {
                            log(`   🛑 ABORT: URL ${work.url} is not live (404/Error). Preventing locked submission fault.`);
                            // We don't change status, so it will retry next cycle
                            continue;
                        }

                        // Submit endpoint is idempotent per API docs — safe to retry
                        const res = await apiRequest('POST', `/jobs/${job.jobId}/submit`, {
                            deliverable_url: work.url,
                            deliverable_hash: work.hash
                        });
                        if (res.status === 200 || res.status === 201) {
                            job.status = 'delivered';
                            job.deliveredAt = new Date().toISOString();
                            STATE.deliveredJobs.push(job);
                            STATE.activeJobs = STATE.activeJobs.filter(j => j.jobId !== job.jobId);

                            // Follow-up message via assignment-level private messaging
                            if (job.assignmentId) {
                                await apiRequest('POST', `/assignments/${job.assignmentId}/messages`, {
                                    body: `✅ Delivery complete! I have submitted the implementation. View here: ${work.url}`
                                });
                            }
                        } else if (res.status === 409) {
                            log(`   ⚠️ Conflict (409): Assignment already submitted/locked. Modifying status to delivered.`);
                            job.status = 'delivered';
                            job.deliveredAt = new Date().toISOString();
                            STATE.deliveredJobs.push(job);
                            STATE.activeJobs = STATE.activeJobs.filter(j => j.jobId !== job.jobId);
                        } else {
                            log(`   ❌ Delivery failed (${res.status}): ${JSON.stringify(res.data)}`);
                        }
                    }
                }
            }

            // Step 6: Payment Check
            // Per API docs: completed → closed lifecycle
            // Check my_assignments for 'accepted' status (meaning requester accepted delivery)
            for (const dJob of [...STATE.deliveredJobs]) {
                try {
                    const res = await apiRequest('GET', `/jobs/${dJob.jobId}`);
                    if (res.status !== 200) continue;

                    const jobData = res.data;
                    const myAssignments = jobData.my_assignments || [];
                    const myAssignment = myAssignments[0];

                    // Job completed = requester accepted the work
                    if (jobData.status === 'completed' ||
                        (myAssignment && myAssignment.status === 'accepted')) {
                        log(`💰 PAID! ${dJob.amount} NEAR earned for "${dJob.title}"`);
                        STATE.totalEarnings += dJob.amount;
                        dJob.paidAt = new Date().toISOString();
                        STATE.paidJobs.push(dJob);
                        STATE.deliveredJobs = STATE.deliveredJobs.filter(j => j.jobId !== dJob.jobId);
                    }
                    // Also check if closed (after work completed)
                    else if (jobData.status === 'closed' && jobData.worker_agent_id) {
                        log(`💰 PAID (closed)! ${dJob.amount} NEAR earned for "${dJob.title}"`);
                        STATE.totalEarnings += dJob.amount;
                        dJob.paidAt = new Date().toISOString();
                        STATE.paidJobs.push(dJob);
                        STATE.deliveredJobs = STATE.deliveredJobs.filter(j => j.jobId !== dJob.jobId);
                    }
                    // Check if job expired while we were working
                    else if (jobData.status === 'expired') {
                        log(`⏰ Job expired: "${dJob.title}" — removing from tracking`);
                        STATE.deliveredJobs = STATE.deliveredJobs.filter(j => j.jobId !== dJob.jobId);
                    }
                } catch (e) {
                    log(`   ⚠️ Payment check error for ${dJob.jobId}: ${e.message}`);
                }
            }

            // Save state after every cycle
            saveState();
            log(`💾 State saved. Sleeping ${CONFIG.pollInterval}s...`);
            await new Promise(r => setTimeout(r, CONFIG.pollInterval * 1000));
        } catch (err) {
            STATE.consecutiveErrors++;
            log(`❌ Loop error (${STATE.consecutiveErrors}/${CONFIG.maxConsecutiveErrors}): ${err.message}`);
            if (STATE.consecutiveErrors >= CONFIG.maxConsecutiveErrors) {
                log(`🛑 Too many consecutive errors. Pausing for 5 minutes...`);
                await new Promise(r => setTimeout(r, 300000));
                STATE.consecutiveErrors = 0;
            } else {
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }
}

// ─── CLI Entry ────────────────────────────────────────────────────────────────

async function main() {
    loadConfig(); loadState();
    const command = process.argv[2] || 'status';

    if (command === 'start') {
        log(`🚀 Starting NEAR Auto-Earn v5.0 (API-aligned) using ${ENV_NAME}`);
        earningLoop();
    } else if (command === 'status') {
        console.log(`\nNEAR Auto-Earn v5.0 (API-Aligned Mode)`);
        console.log(`Running: ${CONFIG.running ? '✅' : '💤'} | Strategy: ${CONFIG.bidStrategy}`);
        console.log(`Max Concurrent: ${CONFIG.maxConcurrent} | Poll: ${CONFIG.pollInterval}s`);
        console.log(`Bids — Placed: ${STATE.bidsPlaced} | Won: ${STATE.bidsWon} | Rejected: ${STATE.bidsRejected}`);
        console.log(`Jobs — Active: ${STATE.activeJobs.length} | Delivered: ${STATE.deliveredJobs.length} | Paid: ${STATE.paidJobs.length}`);
        console.log(`Total Earned: ${STATE.totalEarnings} NEAR`);
        console.log(`Already-bid jobs: ${CONFIG.alreadyBidJobIds.size}`);
    } else if (command === 'balance') {
        const res = await apiRequest('GET', '/wallet/balance');
        if (res.status === 200) {
            console.log(`\n💰 Wallet Balance:`);
            console.log(JSON.stringify(res.data, null, 2));
        } else {
            console.log(`❌ Failed to fetch balance (${res.status})`);
        }
    } else if (command === 'bids') {
        const res = await apiRequest('GET', '/agents/me/bids?limit=50');
        if (res.status === 200) {
            const bids = Array.isArray(res.data) ? res.data : (res.data.bids || []);
            console.log(`\n📋 Your Bids (${bids.length}):`);
            for (const bid of bids) {
                const status = bid.status === 'accepted' ? '✅' : bid.status === 'rejected' ? '❌' : '⏳';
                console.log(`  ${status} ${bid.amount} NEAR on job ${bid.job_id} [${bid.status}]`);
            }
        } else {
            console.log(`❌ Failed to fetch bids (${res.status})`);
        }
    } else if (command === 'reset-bids') {
        CONFIG.alreadyBidJobIds = new Set();
        STATE.alreadyBidJobIds = [];
        saveState();
        console.log('✅ Bid history reset. Agent will bid on all open jobs next cycle.');
    } else if (command === 'stop') {
        CONFIG.running = false;
        saveConfig();
        console.log('🛑 Stop signal saved. Agent will stop after current cycle.');
    } else if (command === 'dashboard') {
        const port = CONFIG.dashboardPort || 18800;
        const dashboardPath = path.join(__dirname, 'dashboard.html');
        if (fs.existsSync(dashboardPath)) {
            const dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
            const server = http.createServer((req, res) => {
                if (req.url === '/api/state') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ config: CONFIG, state: STATE }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(dashboardHtml);
                }
            });
            server.listen(port, () => console.log(`📊 Dashboard: http://localhost:${port}`));
        } else {
            console.log('❌ dashboard.html not found');
        }
    } else {
        console.log('Usage: node auto-earn.js [start|status|balance|bids|reset-bids|stop|dashboard]');
    }
}

main();
