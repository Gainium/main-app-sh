# Contributing to Gainium Main Backend

Welcome to the Gainium main backend repository! This guide will help you contribute to our comprehensive crypto-trading platform that provides automated trading bots, backtesting, and portfolio management.

## Contributor License Agreement (CLA)

This project is licensed under the **Fair Core License 1.0
(FCL-1.0-Apache-2.0)** (see [`LICENSE`](./LICENSE)). Before your first
contribution can be merged, you must sign our Contributor License
Agreement.

The process is automated by a GitHub Action:

1. Open your pull request.
2. The CLA bot will comment on the PR with a link to [`CLA.md`](./CLA.md).
3. Read the CLA. If you agree, post the exact sentence the bot tells you
   in a PR comment:

   > `I have read the CLA Document and I hereby sign the CLA`

4. The bot records your signature and the PR is unblocked. You only need
   to sign once — future PRs from the same GitHub account are auto-cleared.

## Table of Contents

- [Overview](#overview)
- [Development Setup](#development-setup)
- [Architecture Overview](#architecture-overview)
- [Core Bot Systems](#core-bot-systems)
- [GraphQL API Development](#graphql-api-development)
- [Development Guidelines](#development-guidelines)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)

## Overview

Gainium is a TypeScript-based crypto-trading platform that operates as a microservice architecture. The main backend handles bot orchestration, user management, GraphQL API, and real-time data streaming.

### Core Services

| Service | Description | Script |
|---------|-------------|---------|
| **Main API Server** | GraphQL API with authentication and trading endpoints | `npm run server` |
| **Bot Services** | Workers executing DCA, Grid, Combo, and Hedge strategies | `npm run bots:*` |
| **Stream Service** | WebSocket server for real-time frontend updates | `npm run stream` |
| **Indicators Service** | Technical indicators calculation and streaming | `npm run indicators` |
| **Backtest Service** | Historical strategy testing service | `npm run backtest` |
| **Cron Service** | Scheduled maintenance and data updates | `npm run cron` |

## Development Setup

### Prerequisites

- **Node.js** ≥ 18
- **MongoDB** (running instance)
- **Redis** (for caching and real-time data)
- **RabbitMQ** (for message queuing)

### Installation

1. **Clone and Install Dependencies**

```bash
git clone <repository-url>
cd app-sh
npm install
```

2. **Initialize Internal Packages**

```bash
npm run fullInit  # Installs @gainium/indicators and @gainium/backtester
```

3. **Environment Setup**

Configure your `.env` file with necessary database connections, API keys, and service endpoints.

4. **Build and Run**

```bash
# Build TypeScript
npm run build

# Run all services
npm run all

# Or run individual services
npm run server          # Main GraphQL API
npm run bots:dca       # DCA bot service
npm run bots:grid      # Grid bot service
npm run bots:combo     # Combo bot service
npm run stream         # WebSocket service
npm run indicators     # Technical indicators service
```

## Architecture Overview

### Microservice Design

```
┌─────────────────────────────────────────┐
│               Frontend                  │
│         (React Dashboard)               │
└─────────────┬───────────────────────────┘
              │ GraphQL + WebSocket
┌─────────────▼───────────────────────────┐
│           Main API Server               │
│     (GraphQL + Authentication)          │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│           Bot Orchestrator              │
│  ┌─────────┐ ┌─────────┐ ┌─────────────┐│
│  │   DCA   │ │  Grid   │ │   Combo     ││
│  │ Workers │ │ Workers │ │  Workers    ││
│  └─────────┘ └─────────┘ └─────────────┘│
│  ┌─────────┐ ┌─────────────────────────┐ │
│  │ Hedge   │ │     Stream Service      │ │
│  │ Workers │ │   (Real-time Updates)   │ │
│  └─────────┘ └─────────────────────────┘ │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│          Data Layer                     │
│  MongoDB + Redis + RabbitMQ + Files    │
└─────────────────────────────────────────┘
```

### Key Components

- **Bot Class**: Central orchestrator managing worker threads for different bot types
- **GraphQL Resolvers**: Handle API queries and mutations for all operations
- **Worker Threads**: Isolated environments running individual bot instances
- **Exchange Integrations**: Connectors to various cryptocurrency exchanges
- **Real-time Stream**: WebSocket connections for live updates

## Core Bot Systems

### Bot Types and Strategies

#### 1. DCA (Dollar Cost Averaging) Bots
- **Purpose**: Gradual position building with safety orders
- **Worker Script**: `npm run bots:dca`
- **Key Features**: Safety orders, take profit levels, custom indicators
- **File Structure**: `src/bot/dca/`

#### 2. Grid Trading Bots
- **Purpose**: Buy low, sell high within defined price ranges
- **Worker Script**: `npm run bots:grid`
- **Key Features**: Dynamic grid levels, profit reinvestment
- **File Structure**: `src/bot/` (main grid logic)

#### 3. Combo Bots
- **Purpose**: Combine DCA and Grid strategies
- **Worker Script**: `npm run bots:combo`
- **Key Features**: Multi-strategy approach, adaptive behavior
- **File Structure**: `src/bot/` (combo helpers)

#### 4. Hedge Bots
- **Purpose**: Risk management through opposing positions
- **Worker Scripts**: `npm run bots:hedge:dca`, `npm run bots:hedge:combo`
- **Key Features**: Long/short position management, risk mitigation

### Bot Worker Architecture

```typescript
// Example bot worker creation
protected async createNewBot(
  botId: string,
  botType: BotType,
  userId: string,
  exchange: ExchangeEnum,
  uuid: string,
  args: unknown[],
  callback: (worker: Worker) => void,
  paperContext: boolean,
  dcaType?: DCATypeEnum,
) {
  const worker = await this.getWorkerForNewBot(botType, userId)
  
  // Register bot with worker
  worker.postMessage({
    do: 'create',
    botType,
    botId,
    args,
    userId,
    exchange,
  })
  
  // Track bot in appropriate collection
  if (botType === BotType.dca) {
    this.dcaBots.push({ id: botId, worker: worker.threadId, userId, uuid, type: botType, paperContext })
  }
  // Similar for other bot types...
}
```

### Bot Lifecycle Management

1. **Creation**: Bot parameters validated, worker assigned, instance created
2. **Execution**: Worker thread runs bot logic, monitors market conditions
3. **Updates**: Real-time price data triggers bot decisions
4. **Termination**: Bot stopped, positions closed, cleanup performed

## GraphQL API Development

### Schema Organization

The GraphQL schema is organized into logical sections:

```typescript
// Basic schema with common types
export const BasicSchema = /* GraphQL */ `
  scalar Date
  scalar StringOrNumber
  
  interface BasicResponse {
    status: Status
    reason: String
  }
  
  type Query {
    getUsdRate: getUsdRateResponse
    getPairInfo(input: getPairInput!): getPairResponse
    getAllPairs: getAllPairsResponse
  }
`
```

### Resolver Patterns

```typescript
// Example resolver structure
const resolvers = {
  Query: {
    getBotList: async (parent, args, context) => {
      const { user, paperContext } = context
      return Bot.getInstance().getBotList(user.id, args.type, paperContext)
    }
  },
  
  Mutation: {
    createBot: async (parent, args, context) => {
      const { user, paperContext } = context
      return Bot.getInstance().createBot(args.input, user.id, paperContext)
    }
  }
}
```

### Context and Authentication

```typescript
type ApolloContext = {
  token: string
  userAgent?: string
  paperContext: boolean  // Live vs Paper trading
  ip?: string
  req: express.Request
}
```

## Development Guidelines

### Code Organization

1. **Bot Logic**: Keep bot strategies in `src/bot/` with clear separation by type
2. **GraphQL**: Schema in `src/graphql/schema.ts`, resolvers in `src/graphql/resolvers.ts`
3. **Database**: MongoDB models in `src/db/`, utilities in `src/db/utils.ts`
4. **Services**: Individual services in `src/server/`

### Bot Development Patterns

1. **Worker Isolation**: Each bot runs in isolated worker thread
2. **Message Passing**: Communication via postMessage/onMessage
3. **State Management**: Bot state persisted in MongoDB
4. **Error Handling**: Comprehensive error catching with restart capabilities

```typescript
// Worker message handling pattern
protected async processWorkerMessage(data: BotParentEventsDto) {
  if (data.event === 'createBot' && data.create) {
    this.processCreateBotMessage(data.botId)
  }
  if (data.event === 'botClosed' && data.botId && data.botType) {
    this.processBotClosedMessage(data.botId, data.botType)
  }
}
```

### Database Patterns

1. **Aggregation Pipelines**: Use for complex queries and analytics
2. **Indexed Queries**: Ensure proper indexing for performance
3. **Atomic Operations**: Use transactions for multi-document updates
4. **Soft Deletes**: Mark records as deleted rather than removing

### GraphQL Best Practices

1. **Input Validation**: Validate all inputs using custom scalars
2. **Error Handling**: Return structured error responses
3. **Authentication**: Verify JWT tokens in context
4. **Pagination**: Use cursor-based pagination for large datasets

```typescript
// Example GraphQL input validation
input CreateBotInput {
  name: String!
  exchange: Exchange!
  pair: String!
  strategy: BotStrategy!
  settings: BotSettingsInput!
}
```

## Testing

### Unit Testing

```bash
# Run unit tests
npm test

# Test specific components
npm test -- --grep "Bot"
npm test -- --grep "GraphQL"
```

### Integration Testing

```bash
# Test bot functionality
npm run test:bots

# Test GraphQL endpoints
npm run test:graphql
```

### Manual Testing

1. **Bot Testing**: Create test bots in paper trading mode
2. **API Testing**: Use GraphQL playground for query testing
3. **WebSocket Testing**: Monitor real-time updates during bot execution

## Pull Request Process

### Before Creating PR

1. **Code Quality**
```bash
npm run lint          # Check code style
npm run lint:fix      # Auto-fix issues
npm run build         # Verify build success
```

2. **Testing**
```bash
npm test              # Run all tests
npm run test:integration  # Integration tests
```

### PR Requirements

1. **Branch Naming**
   - `feature/bot-enhancement-*`
   - `fix/graphql-resolver-*`
   - `refactor/worker-optimization-*`

2. **Commit Messages**
   - `feat: add new DCA strategy option`
   - `fix: resolve bot worker memory leak`
   - `refactor: optimize GraphQL query performance`

3. **Documentation**
   - Update bot strategy documentation
   - Add GraphQL schema comments
   - Document any breaking changes

### Code Review Checklist

- [ ] Bot logic follows established patterns
- [ ] GraphQL schema changes are backward compatible
- [ ] Worker thread safety considered
- [ ] Database queries optimized
- [ ] Error handling implemented
- [ ] Tests added for new functionality
- [ ] No sensitive data logged
- [ ] Memory leaks prevented

### Service-Specific Guidelines

#### Bot Services
- Ensure proper worker cleanup on termination
- Validate exchange API limits and rate limiting
- Implement proper error recovery mechanisms
- Test with both live and paper trading contexts

#### GraphQL API
- Maintain schema backward compatibility
- Implement proper authentication checks
- Use efficient database queries
- Add rate limiting for expensive operations

#### Stream Service
- Handle WebSocket connection drops gracefully
- Implement proper message queuing
- Ensure real-time data accuracy
- Test with multiple concurrent connections

### Performance Considerations

1. **Bot Workers**: Monitor memory usage and CPU consumption
2. **Database**: Use aggregation pipelines for complex queries
3. **GraphQL**: Implement DataLoader for N+1 query prevention
4. **Caching**: Use Redis for frequently accessed data

### Security Guidelines

1. **API Keys**: Never log exchange API credentials
2. **User Data**: Ensure proper data isolation between users
3. **Rate Limiting**: Implement on all external endpoints
4. **Input Validation**: Sanitize all user inputs

Thank you for contributing to Gainium! Your contributions help make crypto trading more accessible and profitable for users worldwide.