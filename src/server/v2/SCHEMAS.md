# Gainium API v2.0 - Schema Reference

This document contains detailed schema definitions for all API endpoints.

## Overview

All schemas include field descriptions, types, validation rules, and examples.
This documentation is automatically generated from the OpenAPI specification.

**Last Updated:** 2026-08-29T02:55:26.135Z

---

## APIListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## APIResponse

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum: `OK|NOTOK` | Yes | Request execution status |
| `reason` | string | Yes | Error reason if status is NOTOK |

### Example

```json
{
  "status": "OK",
  "reason": null
}
```


---

## AddFundsSchema

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `qty` | string | Yes | Amount to add |
| `asset` | enum: `base|quote` | No | Asset type (required for fixed type) |
| `symbol` | string | No | Trading symbol (optional) |
| `type` | enum: `fixed|perc` | No | Funds type (default is fixed) |

### Example

```json
{
  "qty": "example-string",
  "asset": "base",
  "symbol": "BTC/USDT",
  "type": "fixed"
}
```


---

## BacktestCostEstimate

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## BacktestDCAConfig

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exchange` | string | Yes | Exchange identifier |
| `exchangeUUID` | string | Yes | Unique exchange connection identifier |
| `settings` | [DCABotSettings](#dcabotsettings) | No |  |
| `from` | integer | No | Backtest start timestamp (milliseconds) |
| `to` | integer | No | Backtest end timestamp (milliseconds) |
| `interval` | string | No | Chart interval for backtest |
| `fromBacktest` | boolean | No | Import from previous backtest |
| `trades` | boolean | No | Include trade details in results |
| `paperContext` | boolean | No | Paper trading context |

### Example

```json
{
  "exchange": "550e8400-e29b-41d4-a716-446655440000",
  "exchangeUUID": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "settings": {
      "name": "Example Bot"
    },
    "status": "active",
    "exchange": "binance"
  },
  "from": 0,
  "to": 0,
  "interval": "example-string",
  "fromBacktest": true,
  "trades": true,
  "paperContext": "2.5"
}
```


---

## BacktestGridConfig

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exchange` | string | Yes | Exchange identifier |
| `exchangeUUID` | string | Yes | Unique exchange connection identifier |
| `settings` | [BotSettings](#botsettings) | No |  |
| `from` | integer | No | Backtest start timestamp (milliseconds) |
| `to` | integer | No | Backtest end timestamp (milliseconds) |
| `interval` | string | No | Chart interval for backtest |
| `fromBacktest` | boolean | No | Import from previous backtest |
| `trades` | boolean | No | Include trade details in results |
| `paperContext` | boolean | No | Paper trading context |

### Example

```json
{
  "exchange": "550e8400-e29b-41d4-a716-446655440000",
  "exchangeUUID": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "settings": {
      "name": "Example Bot"
    },
    "status": "active",
    "exchange": "binance"
  },
  "from": 0,
  "to": 0,
  "interval": "example-string",
  "fromBacktest": true,
  "trades": true,
  "paperContext": "2.5"
}
```


---

## BacktestRequest

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload` | [ServerSideBacktestPayload](#serversidebacktestpayload) | Yes |  |
| `symbols` | Array<[BacktestSymbol](#backtestsymbol)> | Yes | Array of trading symbols for backtest |

### Example

```json
{
  "payload": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "exampleField": "Referenced ServerSideBacktestPayload schema"
  },
  "symbols": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced BacktestSymbol schema"
    }
  ]
}
```


---

## BacktestRequestItem

A single backtest request record including optional embedded result

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | string | No | MongoDB ObjectId of the request |
| `status` | enum: `pending|loadingData|processing|success|failed` | No | Current processing status |
| `type` | enum: `dca|combo|grid` | No | Bot type for this backtest |
| `exchange` | string | No | Exchange code |
| `exchangeUUID` | string | No | Exchange connection UUID |
| `symbols` | Array<[BacktestSymbol](#backtestsymbol)> | No | Trading pairs included in the backtest |
| `cost` | integer | No | Credits charged for this backtest |
| `backtestId` | string | No | shareId of the saved backtest result (present when status is success) |
| `statusReason` | string | No | Human-readable reason for the current status (usually set on failure) |
| `statusHistory` | Array<[BacktestStatusHistoryItem](#backteststatushistoryitem)> | No | Full timeline of status transitions |
| `payload` | object | No | Full backtest configuration payload (only included when payload field is selected) |
| `backtest` | object | No | Embedded backtest result object. Present when backtestId is set and
one or more `backtest.*` fields are selected (or no field filter).
Use `backtest.financial`, `backtest.settings`, etc. for field selection.
 |
| `created` | string | No | ISO timestamp when the request was created |
| `updated` | string | No | ISO timestamp of last update |

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "type": "dca",
  "exchange": "binance",
  "exchangeUUID": "550e8400-e29b-41d4-a716-446655440000",
  "symbols": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced BacktestSymbol schema"
    }
  ],
  "cost": 0,
  "backtestId": "550e8400-e29b-41d4-a716-446655440000",
  "statusReason": "active",
  "statusHistory": "active",
  "payload": {},
  "backtest": {},
  "created": "2024-01-15T10:30:00.000Z",
  "updated": "2024-01-15T10:30:00.000Z"
}
```


---

## BacktestRequestListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## BacktestRequestSingleResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## BacktestResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## BacktestStatusHistoryItem

A single status transition entry for a backtest request

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum: `pending|loadingData|processing|success|failed` | No | Status at this point in time |
| `time` | integer | No | Unix timestamp (ms) when the status was set |

### Example

```json
{
  "status": "pending",
  "time": "2024-01-15T10:30:00.000Z"
}
```


---

## BacktestSymbol

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pair` | string | Yes | Trading pair symbol |
| `baseAsset` | string | Yes | Base asset symbol (e.g., BTC in BTC_USDT) |
| `quoteAsset` | string | Yes | Quote asset symbol (e.g., USDT in BTC_USDT) |

### Example

```json
{
  "pair": "BTC/USDT",
  "baseAsset": "BTC/USDT",
  "quoteAsset": "BTC/USDT"
}
```


---

## BalanceListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## BalanceMinimal

Minimal balance representation

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `asset` | string | Yes | Asset symbol |
| `free` | string | Yes | Available balance |
| `locked` | string | Yes | Locked balance (in orders) |
| `exchangeUUID` | string | Yes | Exchange connection UUID |

### Example

```json
{
  "asset": "BTC",
  "free": "0.05123",
  "locked": "0.00000",
  "exchangeUUID": "550e8400-e29b-41d4-a716-446655440000"
}
```


---

## BalanceStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## BaseSettings

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No |  |
| `profitCurrency` | object | No |  |
| `orderFixedIn` | object | No |  |
| `pair` | string | No | Trading pair symbol |
| `futures` | boolean | No | Enable futures trading |
| `coinm` | boolean | No | Coin-margined futures |
| `marginType` | enum: `inherit|cross|isolated` | No | Margin type for futures |
| `leverage` | number | No | Leverage multiplier |
| `strategy` | enum: `LONG|SHORT` | No | Trading strategy direction (long or short) |

### Example

```json
{
  "name": "BTC/USDT",
  "profitCurrency": {},
  "orderFixedIn": {},
  "pair": "BTC/USDT",
  "futures": true,
  "coinm": true,
  "marginType": "inherit",
  "leverage": 0,
  "strategy": "LONG"
}
```


---

## BotSchemaDefinition

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `botType` | enum: `dca|combo|grid` | Yes |  |
| `label` | string | Yes |  |
| `description` | string | Yes |  |
| `sections` | Array<[SectionDefinition](#sectiondefinition)> | Yes |  |

### Example

```json
{
  "botType": "dca",
  "label": "example-string",
  "description": "example-string",
  "sections": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced SectionDefinition schema"
    }
  ]
}
```


---

## BotSettings

BotSettings configuration

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ComboBacktestRequest

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload` | object | Yes | Combo backtest payload without type field (specified in URL) |
| `symbols` | Array<[BacktestSymbol](#backtestsymbol)> | Yes | Array of trading symbols for backtest |

### Example

```json
{
  "payload": {},
  "symbols": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced BacktestSymbol schema"
    }
  ]
}
```


---

## ComboBotExtended

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "name": "BTC Long Strategy",
    "pair": [
      "BTC/USDT"
    ],
    "strategy": "LONG",
    "baseOrderSize": "100",
    "tpPerc": "2.5"
  },
  "status": "active",
  "exchange": "binance",
  "profit": {
    "total": "125.50",
    "totalUsd": "125.50"
  },
  "deals": {
    "active": 1,
    "total": 5
  }
}
```


---

## ComboBotListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ComboBotMinimal

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "name": "BTC Long Strategy"
  },
  "status": "active"
}
```


---

## ComboBotSettings

ComboBotSettings configuration

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ComboBotStandard

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "name": "BTC Long Strategy",
    "pair": [
      "BTC/USDT"
    ]
  },
  "status": "active",
  "exchange": "binance"
}
```


---

## ComboDealExtended

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "botId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "open",
  "symbol": {
    "symbol": "BTC/USDT"
  },
  "profit": {
    "total": "25.50",
    "totalUsd": "25.50",
    "percentage": "2.5"
  },
  "avgPrice": "45000.00",
  "cost": "1000.00"
}
```


---

## ComboDealMinimal

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "botId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "open",
  "symbol": "BTC/USDT",
  "profit": {
    "total": "25.50"
  }
}
```


---

## ComboDealStandard

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "botId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "open",
  "symbol": "BTC/USDT",
  "profit": {
    "total": "25.50"
  }
}
```


---

## CreateComboBotInput

Input schema for creating a new Combo bot. Inherits all ComboBotSettings properties plus additional required fields for creation.

Combo bots extend DCA bots with additional grid-level functionality. Some settings in ComboBotSettings type are not used - refer to API documentation for excluded fields list.

Note: The following properties are auto-generated and should NOT be provided in the request:
- `futures` (auto-detected from exchange configuration)
- `coinm` (auto-detected from exchange configuration)
- `paperContext` (provided via paper-context header)


### Example

```json
{}
```


---

## CreateDCABotInput

Input schema for creating a new DCA bot. Inherits all DCABotSettings properties plus additional required fields for creation.

Note: The following properties are auto-generated and should NOT be provided in the request:
- `futures` (auto-detected from exchange configuration)
- `coinm` (auto-detected from exchange configuration)
- `paperContext` (provided via paper-context header)


### Example

```json
{}
```


---

## CreateGridBotInput

Input schema for creating a new Grid bot. Grid bots automatically buy and sell assets within a configured price range.

Note: The following properties are auto-generated and should NOT be provided in the request:
- `futures` (auto-detected from exchange configuration)
- `coinm` (auto-detected from exchange configuration)
- `paperContext` (provided via paper-context header)


### Example

```json
{}
```


---

## CreateTerminalDealInput

Input schema for creating a new Terminal Deal (one-time trade). Inherits all DCABotSettings properties plus additional required fields.

Terminal deals are one-time trades that execute immediately and don't continue running like regular bots.
The type field will be automatically set to 'terminal'.

Note: The following properties are auto-generated and should NOT be provided in the request:
- `futures` (auto-detected from exchange configuration)
- `coinm` (auto-detected from exchange configuration)
- `type` (automatically set to 'terminal')
- `paperContext` (provided via paper-context header)


### Example

```json
{}
```


---

## DCABotExtended

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## DCABotListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## DCABotMinimal

Minimal DCA bot representation

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | string | No | Internal MongoDB ID |
| `uuid` | string | No | Unique bot identifier |
| `settings` | object | No |  |
| `status` | enum: `open|closed|range|error|archive|monitoring` | No | Bot operational status |
| `exchange` | string | No | Exchange code |
| `exchangeUUID` | string | No | Exchange connection UUID |
| `paperContext` | boolean | No | Paper trading context ID (null for real trading) |

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "name": "BTC/USDT"
  },
  "status": "open",
  "exchange": "binance",
  "exchangeUUID": "550e8400-e29b-41d4-a716-446655440000",
  "paperContext": "2.5"
}
```


---

## DCABotSettings

DCABotSettings configuration

### Example

```json
{
  "name": "BTC Long Strategy",
  "pair": [
    "BTC/USDT"
  ],
  "strategy": "LONG",
  "baseOrderSize": "100",
  "tpPerc": "2.5",
  "step": "1.5",
  "ordersCount": 5,
  "useDca": true,
  "useTp": true
}
```


---

## DCABotStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## DCACustom

DCACustom configuration

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `step` | string | No | Price deviation % for next DCA order |
| `size` | string | No | Custom order size |
| `uuid` | string | No | Unique identifier |

### Example

```json
{
  "step": "example-string",
  "size": "example-string",
  "uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```


---

## DCADealExtended

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## DCADealMinimal

Minimal DCA deal representation

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | string | No |  |
| `botId` | string | No | Parent bot UUID |
| `status` | enum: `closed|open|start|error|canceled` | No | Deal status |
| `symbol` | object | No |  |
| `profit` | object | No |  |
| `funding` | object | No | Funding fees accrued on the deal's futures position |
| `created` | number | No | Deal creation timestamp |

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "botId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "closed",
  "symbol": "BTC/USDT",
  "profit": {
    "total": 0,
    "totalUsd": 0
  },
  "funding": {
    "total": 0,
    "totalUsd": 0,
    "lastTime": "2024-01-15T10:30:00.000Z",
    "history": [
      {
        "time": "2024-01-15T10:30:00.000Z",
        "rate": 0,
        "markPrice": "1234.56",
        "qty": 0,
        "feeQuote": 0,
        "feeUsd": 0
      }
    ]
  },
  "created": 0
}
```


---

## DCADealStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## DcaBacktestRequest

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload` | object | Yes | DCA backtest payload without type field (specified in URL) |
| `symbols` | Array<[BacktestSymbol](#backtestsymbol)> | Yes | Array of trading symbols for backtest |

### Example

```json
{
  "payload": {},
  "symbols": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced BacktestSymbol schema"
    }
  ]
}
```


---

## DealListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ErrorResponse

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum: `NOTOK` | Yes |  |
| `reason` | string | Yes | Error description |

### Example

```json
{
  "status": "NOTOK",
  "reason": "example-string"
}
```


---

## ExchangeGeneralListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ExchangeListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ExchangeMinimal

Minimal exchange representation

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | Exchange code |
| `market` | enum: `spot|futures` | Yes | Market type |
| `id` | string | Yes | Exchange connection ID |
| `name` | string | Yes | Exchange display name |

### Example

```json
{
  "code": "binance",
  "market": "spot",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "BTC/USDT"
}
```


---

## ExchangeStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## FieldDefinition

Describes a single field on a bot settings or indicator object. `type` is the runtime JS type; `validators` are the constraint labels; `enum` lists allowed values when type = "enum".


### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes |  |
| `type` | enum: `string|number|numberInString|boolean|enum|array|object|Date` | Yes |  |
| `required` | boolean | Yes |  |
| `validators` | Array<string> | Yes |  |
| `enum` | Array<string> | No | Allowed values, only present when type = "enum" |
| `itemType` | string | No | Element type when type = "array" |
| `min` | number | No |  |
| `max` | number | No |  |
| `maxPrecision` | number | No |  |
| `maxLength` | number | No |  |
| `default` | any | No | Default value used when field is omitted |
| `note` | string | No | Extra human-readable usage guidance |
| `example` | any | No | Representative example value |

### Example

```json
{
  "name": "BTC/USDT",
  "type": "string",
  "required": true,
  "validators": "550e8400-e29b-41d4-a716-446655440000",
  "enum": [
    "example-string"
  ],
  "itemType": "example-string",
  "min": 0,
  "max": 0,
  "maxPrecision": 0,
  "maxLength": 0,
  "default": {
    "exampleField": "example-value"
  },
  "note": "example-string",
  "example": {
    "exampleField": "example-value"
  }
}
```


---

## GlobalVariable

Global variable

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | string | Yes | Global variable ID |
| `name` | string | Yes | Variable name |
| `type` | enum: `text|int|float` | Yes | Variable type |
| `value` | string | Yes | Variable value |
| `userId` | string | Yes | User ID who owns this variable |
| `botAmount` | number | No | Number of bots using this variable |
| `createdAt` | string | No | Creation timestamp |
| `updatedAt` | string | No | Last update timestamp |

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "BTC/USDT",
  "type": "text",
  "value": "example-string",
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "botAmount": "1234.56",
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:00.000Z"
}
```


---

## GlobalVariableListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## GridBacktestRequest

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `payload` | object | Yes | Grid backtest payload without type field (specified in URL) |
| `symbols` | Array<[BacktestSymbol](#backtestsymbol)> | Yes | Array of trading symbols for backtest |

### Example

```json
{
  "payload": {},
  "symbols": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced BacktestSymbol schema"
    }
  ]
}
```


---

## GridBotExtended

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## GridBotListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## GridBotMinimal

Minimal Grid bot representation

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | string | No |  |
| `uuid` | string | No |  |
| `settings` | object | No |  |
| `status` | enum: `open|closed|range|error|archive|monitoring` | No |  |
| `exchange` | string | No |  |
| `exchangeUUID` | string | No |  |
| `paperContext` | boolean | No |  |

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "settings": {
    "name": "BTC/USDT"
  },
  "status": "open",
  "exchange": "example-string",
  "exchangeUUID": "550e8400-e29b-41d4-a716-446655440000",
  "paperContext": "2.5"
}
```


---

## GridBotStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## HedgeBotExtended

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## HedgeBotListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## HedgeBotMinimal

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_id` | string | No |  |
| `uuid` | string | No |  |
| `name` | string | No | The hedge wrapper has no name of its own; this is the long leg's name (falling back to the short leg's, then to "Hedge bot").
 |
| `status` | enum: `open|closed|error|archive|range|monitoring` | No |  |
| `paperContext` | boolean | No |  |

### Example

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "name": "BTC/USDT",
  "status": "open",
  "paperContext": "2.5"
}
```


---

## HedgeBotProfit

Realized profit, SUMMED FROM THE TWO LEGS at read time. The stored value on the hedge document itself is a permanent zero and is never returned. The `*Usd` fields are always exact. The native-unit fields are only meaningful when both legs settle in the same quote asset — check `profitBasis.native`, and prefer `profitByAssets` when it is `mixed`.


### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `total` | number | No | Sum in the shared quote asset. 0 when `profitBasis.native` is `mixed`. |
| `totalUsd` | number | No |  |
| `freeTotal` | number | No |  |
| `freeTotalUsd` | number | No |  |
| `pureBase` | number | No |  |
| `pureQuote` | number | No |  |

### Example

```json
{
  "total": 0,
  "totalUsd": 0,
  "freeTotal": 0,
  "freeTotalUsd": 0,
  "pureBase": 0,
  "pureQuote": 0
}
```


---

## HedgeBotStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## HedgeCloneInput

Overrides for a hedge clone. A hedge bot is two independent legs with their own pairs, exchanges and settings, so overrides are given PER LEG rather than as one flat object. A flat body is rejected with a 400 that says so, rather than being silently ignored. Any key you omit is copied from the source bot; leg names get " (clone)" appended unless you override `name`.


### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `long` | object | No | Settings to override on the long leg. |
| `short` | object | No | Settings to override on the short leg. |
| `sharedSettings` | [HedgeSharedSettings](#hedgesharedsettings) | No |  |

### Example

```json
{
  "long": {},
  "short": {},
  "sharedSettings": {
    "_id": "550e8400-e29b-41d4-a716-446655440000",
    "exampleField": "Referenced HedgeSharedSettings schema"
  }
}
```


---

## HedgeLegAction

### Example

```json
"useBalance"
```


---

## HedgeProfitBasis

How far the native-unit numbers on `profit` can be trusted.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `native` | enum: `exact|mixed` | No | `exact` — both legs settle in the same quote asset, so the native-unit sums on `profit` are meaningful. `mixed` — they do not; those fields are 0 and only the `*Usd` fields and `profitByAssets` are trustworthy.
 |
| `quoteAssets` | Array<string> | No | Distinct quote assets seen across both legs. |

### Example

```json
{
  "native": "exact",
  "quoteAssets": [
    "example-string"
  ]
}
```


---

## HedgeSharedSettings

Take-profit / stop-loss settings the hedge wrapper applies across both legs.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `useTp` | boolean | No |  |
| `tpPerc` | string | No |  |
| `useSl` | boolean | No |  |
| `slPerc` | string | No |  |
| `comboTpBase` | string | No |  |
| `comboTpLimit` | boolean | No |  |
| `comboSlLimit` | boolean | No |  |
| `dealCloseCondition` | string | No |  |
| `dealCloseConditionSL` | string | No |  |

### Example

```json
{
  "useTp": true,
  "tpPerc": "2.5",
  "useSl": true,
  "slPerc": "2.5",
  "comboTpBase": "example-string",
  "comboTpLimit": true,
  "comboSlLimit": true,
  "dealCloseCondition": "example-string",
  "dealCloseConditionSL": "example-string"
}
```


---

## HedgeStartInput

Optional per-leg instruction for what each leg should do with the position it is already holding when it starts. Omit to leave both legs' existing action untouched.


### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hedgeConfig` | object | No |  |

### Example

```json
{
  "hedgeConfig": {
    "LONG": {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced HedgeLegAction schema"
    },
    "SHORT": {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced HedgeLegAction schema"
    }
  }
}
```


---

## IndicatorDefinition

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## IndicatorGroupDefinition

Documents the indicatorGroups mechanism. Every indicator must reference a group via its groupId field. The group object lives in the settings.indicatorGroups array and ties one or more indicators together under a shared action+section with AND/OR logic.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | Yes | Plain-English explanation of how groups work and why they are required. |
| `rules` | Array<string> | Yes | Validation rules that must hold between each indicator and its group. An AI agent must follow all of these when constructing bot settings. |
| `fields` | Array<[FieldDefinition](#fielddefinition)> | Yes | Field definitions for a single IndicatorGroup object in settings.indicatorGroups. |

### Example

```json
{
  "description": "example-string",
  "rules": [
    "example-string"
  ],
  "fields": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced FieldDefinition schema"
    }
  ]
}
```


---

## IndicatorSummary

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes |  |
| `name` | string | Yes |  |
| `description` | string | No |  |
| `supportedActions` | Array<string> | Yes |  |
| `supportedSections` | Array<string> | No |  |
| `supportedIntervals` | Array<string> | No | Only present when the `?exchange=` query parameter is supplied. Lists the candlestick intervals available on that exchange. |

### Example

```json
{
  "type": "example-string",
  "name": "BTC/USDT",
  "description": "example-string",
  "supportedActions": [
    "example-string"
  ],
  "supportedSections": [
    "example-string"
  ],
  "supportedIntervals": [
    "example-string"
  ]
}
```


---

## MultiTP

MultiTP configuration

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | No | Target profit/loss percentage |
| `amount` | string | No | Amount to close at target |
| `uuid` | string | No | Unique identifier |
| `fixed` | string | No | Fixed price target |

### Example

```json
{
  "target": "example-string",
  "amount": "1234.56",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "fixed": "example-string"
}
```


---

## ResponseMeta

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `page` | integer | Yes | Current page number (1-based) |
| `total` | integer | Yes | Total number of items matching query |
| `count` | integer | Yes | Total items in database |
| `onPage` | integer | Yes | Number of items on current page |
| `fields` | Array<string> | Yes | List of fields included in response |

### Example

```json
{
  "page": 0,
  "total": 0,
  "count": 0,
  "onPage": 0,
  "fields": [
    "example-string"
  ]
}
```


---

## ScreenerExtended

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ScreenerListResponse

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## ScreenerMinimal

Minimal screener coin representation

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Coin symbol |
| `name` | string | Yes | Coin full name |
| `currentPrice` | number | Yes | Current price in USD |
| `priceChangePercentage24h` | number | Yes | 24h price change percentage |
| `totalVolume` | number | Yes | 24h trading volume |
| `marketCap` | number | Yes | Market capitalization |
| `marketCapRank` | integer | Yes | Market cap rank |

### Example

```json
{
  "symbol": "BTC/USDT",
  "name": "BTC/USDT",
  "currentPrice": "1234.56",
  "priceChangePercentage24h": "1234.56",
  "totalVolume": 0,
  "marketCap": 0,
  "marketCapRank": 0
}
```


---

## ScreenerStandard

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## SectionDefinition

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes |  |
| `name` | string | Yes |  |
| `description` | string | Yes |  |
| `fields` | Array<[FieldDefinition](#fielddefinition)> | Yes |  |

### Example

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "BTC/USDT",
  "description": "example-string",
  "fields": [
    {
      "_id": "550e8400-e29b-41d4-a716-446655440000",
      "exampleField": "Referenced FieldDefinition schema"
    }
  ]
}
```


---

## SectionSummary

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes |  |
| `name` | string | Yes |  |
| `description` | string | Yes |  |
| `fieldCount` | integer | Yes | Number of fields in this section |

### Example

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "BTC/USDT",
  "description": "example-string",
  "fieldCount": 0
}
```


---

## ServerSideBacktestPayload

### Example

```json
{
  "exampleField": "example-value"
}
```


---

## SettingsIndicatorGroup

SettingsIndicatorGroup configuration

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | Group or item identifier |
| `logic` | enum: `and|or` | No | Logic operator (AND/OR) |
| `action` | enum: `startDeal|closeDeal|startDca|stopBot|riskReward|startBot` | No | Action to trigger |
| `section` | enum: `tp|sl|dca|controller` | No | Settings section (tp/sl/dca/controller) |

### Example

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "logic": "and",
  "action": "startDeal",
  "section": "tp"
}
```


---

## SettingsIndicators

SettingsIndicators configuration

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | enum: `RSI|ADX|BBW|BB|MACD|Stoch|CCI|AO|StochRSI|WR|BullBear|UO|IC|TV|MA|SR|QFL|MFI|PSAR|VO|MOM|BBWP|ECD|XO|MAR|BBPB|DIV|ST|PC|ATR|PP|ADR|ATH|KC|KCPB|UNPNL|DC|OBFVG|SESSION|LW` | No | Bot or indicator type |
| `indicatorLength` | number | No | Indicator period length |
| `indicatorValue` | string | No | Indicator value threshold |
| `indicatorCondition` | enum: `cd|cu|gt|lt` | No | Comparison condition |
| `indicatorInterval` | enum: `1m|3m|5m|15m|30m|1h|2h|4h|8h|1d|1w` | No | Chart timeframe |
| `groupId` | string | No | Indicator group ID |
| `uuid` | string | No | Unique identifier |
| `signal` | enum: `strongBuy|strongSell|buy|sell|bothBuy|bothSell` | No | Trading signal type |
| `condition` | enum: `every|entry` | No | Check condition timing |
| `checkLevel` | number | No | Level to check indicator |
| `maType` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | Moving average type |
| `maCrossingValue` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | MA crossing reference |
| `maCrossingLength` | number | No | Crossing MA length |
| `maCrossingInterval` | enum: `1m|3m|5m|15m|30m|1h|2h|4h|8h|1d|1w` | No | Crossing MA timeframe |
| `maUUID` | string | No | MA indicator UUID reference |
| `bbCrossingValue` | enum: `middle|upper|lower` | No | Bollinger Band line to cross |
| `stochSmoothK` | number | No | Stochastic K smoothing |
| `stochSmoothD` | number | No | Stochastic D smoothing |
| `stochUpper` | string | No | Stochastic overbought level |
| `stochLower` | string | No | Stochastic oversold level |
| `stochRSI` | number | No | Stochastic RSI period |
| `rsiValue` | enum: `k|d` | No | RSI value (K or D line) |
| `rsiValue2` | enum: `k|d|custom` | No | Second RSI value |
| `valueInsteadof` | number | No | Custom value instead of price |
| `leftBars` | number | No | Bars to check on left |
| `rightBars` | number | No | Bars to check on right |
| `srCrossingValue` | enum: `support|resistance` | No | Support or resistance line |
| `basePeriods` | number | No | Base period for calculation |
| `pumpPeriods` | number | No | Pump detection periods |
| `pump` | number | No | Pump threshold value |
| `interval` | number | No | Calculation interval |
| `baseCrack` | number | No | Base crack threshold |
| `indicatorAction` | enum: `startDeal|closeDeal|startDca|stopBot|riskReward|startBot` | No | Action triggered by indicator |
| `section` | enum: `tp|sl|dca|controller` | No | Settings section (tp/sl/dca/controller) |
| `psarStart` | number | No | Parabolic SAR start value |
| `psarInc` | number | No | Parabolic SAR increment |
| `psarMax` | number | No | Parabolic SAR maximum |
| `stochRange` | enum: `upper|lower|both|none` | No | Stochastic range to check |
| `minPercFromLast` | string | No | Minimum % from last signal |
| `orderSize` | string | No | Size of each order |
| `keepConditionBars` | string | No | Bars to keep condition |
| `voShort` | number | No | Volume oscillator short period |
| `voLong` | number | No | Volume oscillator long period |
| `uoFast` | number | No | Ultimate Oscillator fast period |
| `uoMiddle` | number | No | Ultimate Oscillator middle period |
| `uoSlow` | number | No | Ultimate Oscillator slow period |
| `momSource` | string | No | Momentum source price |
| `bbwpLookback` | number | No | BBWP lookback period |
| `ecdTrigger` | enum: `bearish|bullish|both` | No | ECD trigger type |
| `xOscillator2length` | number | No | Second oscillator length |
| `xOscillator2Interval` | enum: `1m|3m|5m|15m|30m|1h|2h|4h|8h|1d|1w` | No | Second oscillator timeframe |
| `xOscillator2voLong` | number | No | Second oscillator long period |
| `xOscillator2voShort` | number | No | Second oscillator short period |
| `xoUUID` | string | No | Cross oscillator UUID |
| `mar1length` | number | No | First MA length for ratio |
| `mar1type` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | First MA type |
| `mar2length` | number | No | Second MA length for ratio |
| `mar2type` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | Second MA type |
| `bbwMult` | number | No | Bollinger Band width multiplier |
| `bbwMa` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | BB moving average type |
| `bbwMaLength` | number | No | BB MA length |
| `macdFast` | number | No | MACD fast period |
| `macdSlow` | number | No | MACD slow period |
| `macdMaSource` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | MACD MA source type |
| `macdMaSignal` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | MACD signal line type |
| `divOscillators` | Array<object> | No | Oscillators for divergence |
| `divType` | enum: `Bullish|Bearish|Hidden Bullish|Hidden Bearish|Any Bullish|Any Bearish` | No | Divergence type |
| `divMinCount` | number | No | Minimum divergence count |
| `factor` | number | No | Supertrend multiplier factor |
| `atrLength` | number | No | ATR period length |
| `stCondition` | enum: `up|down|upToDown|downToUp` | No | Supertrend condition |
| `pcUp` | string | No | Price change up threshold |
| `pcDown` | string | No | Price change down threshold |
| `pcCondition` | enum: `UP|DOWN` | No | Price change direction |
| `pcValue` | string | No | Price change value |
| `ppHighLeft` | number | No | Pivot high left bars |
| `ppHighRight` | number | No | Pivot high right bars |
| `ppLowLeft` | number | No | Pivot low left bars |
| `ppLowRight` | number | No | Pivot low right bars |
| `ppMult` | number | No | Pivot point multiplier |
| `ppValue` | enum: `HH|HL|LH|LL|Any High|Any Low|SL|WL|SH|WH|anyL|anyH|BullM|BearM|SBullBoS|SBearBoS|SBullCHoCH|SBearCHoCH|IBullBoS|IBearBoS|IBullCHoCH|IBearCHoCH|IAnyBull|IAnyBear|SAnyBull|SAnyBear|BullAnyBoS|BearAnyBoS|BullAnyCHoCH|BearAnyCHoCH` | No | Pivot point value type |
| `ppType` | enum: `Price Based|Event Based|Market Based` | No | Pivot point type |
| `riskAtrMult` | string | No | ATR multiplier for risk |
| `dynamicArFactor` | string | No | Dynamic AR factor |
| `athLookback` | number | No | All-time high lookback period |
| `kcMa` | enum: `ema|sma|wma|price|dema|tema|vwma|hma|rma` | No | Keltner Channel MA type |
| `kcRange` | enum: `ATR|TR|R` | No | Keltner Channel range type |
| `kcRangeLength` | number | No | Keltner Channel range length |
| `unpnlValue` | number | No | Unrealized PnL threshold |
| `unpnlCondition` | enum: `cd|cu|gt|lt` | No | Unrealized PnL condition |
| `dcValue` | enum: `basis|lower|upper` | No | Donchian Channel line |
| `obfvgValue` | enum: `bullish|bearish|any` | No | Order block/FVG type |
| `obfvgRef` | enum: `high|low|middle` | No | Order block/FVG reference |
| `sessionDays` | Array<number> | No |  |
| `sessionRule` | enum: `in|out` | No |  |
| `lwThreshold` | string | No |  |
| `lwMaxDuration` | string | No |  |
| `lwValue` | enum: `top|bottom|any` | No |  |
| `lwCondition` | enum: `onStart|during` | No |  |

### Example

```json
{
  "type": "RSI",
  "indicatorLength": 0,
  "indicatorValue": "example-string",
  "indicatorCondition": "cd",
  "indicatorInterval": "1m",
  "groupId": "550e8400-e29b-41d4-a716-446655440000",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "signal": "strongBuy",
  "condition": "every",
  "checkLevel": 0,
  "maType": "ema",
  "maCrossingValue": "ema",
  "maCrossingLength": 0,
  "maCrossingInterval": "1m",
  "maUUID": "550e8400-e29b-41d4-a716-446655440000",
  "bbCrossingValue": "middle",
  "stochSmoothK": 0,
  "stochSmoothD": 0,
  "stochUpper": "example-string",
  "stochLower": "example-string",
  "stochRSI": 0,
  "rsiValue": "k",
  "rsiValue2": "k",
  "valueInsteadof": 0,
  "leftBars": 0,
  "rightBars": 0,
  "srCrossingValue": "support",
  "basePeriods": 0,
  "pumpPeriods": 0,
  "pump": 0,
  "interval": 0,
  "baseCrack": 0,
  "indicatorAction": "startDeal",
  "section": "tp",
  "psarStart": 0,
  "psarInc": 0,
  "psarMax": 0,
  "stochRange": "upper",
  "minPercFromLast": "2.5",
  "orderSize": "example-string",
  "keepConditionBars": "example-string",
  "voShort": 0,
  "voLong": 0,
  "uoFast": 0,
  "uoMiddle": "550e8400-e29b-41d4-a716-446655440000",
  "uoSlow": 0,
  "momSource": "example-string",
  "bbwpLookback": 0,
  "ecdTrigger": "bearish",
  "xOscillator2length": 0,
  "xOscillator2Interval": "1m",
  "xOscillator2voLong": 0,
  "xOscillator2voShort": 0,
  "xoUUID": "550e8400-e29b-41d4-a716-446655440000",
  "mar1length": 0,
  "mar1type": "ema",
  "mar2length": 0,
  "mar2type": "ema",
  "bbwMult": 0,
  "bbwMa": "ema",
  "bbwMaLength": 0,
  "macdFast": 0,
  "macdSlow": 0,
  "macdMaSource": "ema",
  "macdMaSignal": "ema",
  "divOscillators": [
    {}
  ],
  "divType": "Bullish",
  "divMinCount": 0,
  "factor": 0,
  "atrLength": 0,
  "stCondition": "up",
  "pcUp": "example-string",
  "pcDown": "example-string",
  "pcCondition": "UP",
  "pcValue": "example-string",
  "ppHighLeft": 0,
  "ppHighRight": 0,
  "ppLowLeft": 0,
  "ppLowRight": 0,
  "ppMult": 0,
  "ppValue": "HH",
  "ppType": "Price Based",
  "riskAtrMult": "example-string",
  "dynamicArFactor": "example-string",
  "athLookback": 0,
  "kcMa": "ema",
  "kcRange": "ATR",
  "kcRangeLength": 0,
  "unpnlValue": 0,
  "unpnlCondition": "cd",
  "dcValue": "basis",
  "obfvgValue": "bullish",
  "obfvgRef": "high",
  "sessionDays": [
    0
  ],
  "sessionRule": "in",
  "lwThreshold": "example-string",
  "lwMaxDuration": "example-string",
  "lwValue": "top",
  "lwCondition": "onStart"
}
```


---

## UpdateComboBotInput

Input schema for updating Combo bot settings

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Bot name |
| `step` | string | No | Step percentage between DCA orders |
| `ordersCount` | integer | No | DCA orders count |
| `tpPerc` | string | No | Take profit percent |
| `slPerc` | string | No | Stop loss percent |
| `profitCurrency` | enum: `base|quote` | No | Profit currency |
| `orderSize` | string | No | DCA order qty of the deal. |
| `baseOrderSize` | string | No | Base order qty of the deal. |
| `baseStep` | string | No | Top price of base minigrid. |
| `baseGridLevels` | string | No | Base minigrid levels. |
| `gridLevel` | string | No | DCA minigrid levels. |
| `orderSizeType` | enum: `base|quote|percFree|percTotal|usd` | No | Currency reference |
| `startOrderType` | enum: `limit|market` | No | Currency reference |
| `useRiskReduction` | boolean | No | Use risk reduction. Requires riskReductionValue value |
| `riskReductionValue` | string | No | Risk reduction value in % |
| `useReinvest` | boolean | No | Use reinvest profit. Requires reinvestValue value |
| `reinvestValue` | string | No | Reinvest profit value in % |
| `skipBalanceCheck` | boolean | No | Skip balance check |
| `startCondition` | enum: `ASAP|Manual` | No | Start deal condition |
| `maxNumberOfOpenDeals` | string | No | Max number of open deals |
| `useStaticPriceFilter` | boolean | No | Use static price filter. Require minOpenDeal or maxOpenDeal |
| `minOpenDeal` | string | No | Minimum price for open deal |
| `maxOpenDeal` | string | No | Maximum price for open deal |
| `useDynamicPriceFilter` | boolean | No | Use dynamic price filter. Require dynamicPriceFilterDirection, dynamicPriceFilterOverValue or dynamicPriceFilterUnderValue or both, dynamicPriceFilterPriceType |
| `dynamicPriceFilterDirection` | enum: `over|under|overAndUnder` | No | Direction of the price filter. Over require dynamicPriceFilterOverValue field, under require dynamicPriceFilterUnderValue field, overAndUnder require both fields |
| `dynamicPriceFilterOverValue` | string | No | Over value |
| `dynamicPriceFilterUnderValue` | string | No | Over value |
| `dynamicPriceFilterPriceType` | enum: `avg|entry` | No | Price sourse |
| `useNoOverlapDeals` | boolean | No | Use no overlap deals in dynamic price filter |
| `useCooldown` | boolean | No | Use cooldown |
| `cooldownAfterDealStart` | boolean | No | Use cooldown after deal start. Require cooldownAfterDealStartInterval and cooldownAfterDealStartUnits |
| `cooldownAfterDealStartInterval` | number | No | Cooldown after deal start interval |
| `cooldownAfterDealStartUnits` | enum: `seconds|minutes|hours|days` | No | Cooldown after deal start units |
| `cooldownAfterDealStop` | boolean | No | Use cooldown after deal stop. Require cooldownAfterDealStopInterval and cooldownAfterDealStopUnits |
| `cooldownAfterDealStopInterval` | number | No | Cooldown after deal stop interval |
| `cooldownAfterDealStopUnits` | enum: `seconds|minutes|hours|days` | No | Cooldown after deal stop units |
| `useTp` | boolean | No | Use take profit |
| `useSl` | boolean | No | Use stop loss |
| `useDca` | boolean | No | Use DCA orders |
| `useSmartOrders` | boolean | No | Use smart orders |
| `activeOrdersCount` | integer | No | Active orders count |
| `useActiveMinigrids` | boolean | No | Use active minigrids. |
| `comboActiveMinigrids` | string | No | Active minigrids count. |
| `comboUseSmartGrids` | boolean | No | Use smart grids. |
| `comboSmartGridsCount` | integer | No | Smart grids count. |
| `volumeScale` | string | No | Volume scale of DCA orders |
| `stepScale` | string | No | Step scale of DCA orders |
| `comboTpBase` | enum: `full|filled` | No | Base SL on user DCA or max DCA. Default - filled. |

### Example

```json
{
  "name": "BTC/USDT",
  "step": "example-string",
  "ordersCount": 0,
  "tpPerc": "2.5",
  "slPerc": "2.5",
  "profitCurrency": "base",
  "orderSize": "example-string",
  "baseOrderSize": "example-string",
  "baseStep": "example-string",
  "baseGridLevels": "550e8400-e29b-41d4-a716-446655440000",
  "gridLevel": "550e8400-e29b-41d4-a716-446655440000",
  "orderSizeType": "base",
  "startOrderType": "limit",
  "useRiskReduction": true,
  "riskReductionValue": "example-string",
  "useReinvest": true,
  "reinvestValue": "example-string",
  "skipBalanceCheck": "1234.56",
  "startCondition": "ASAP",
  "maxNumberOfOpenDeals": "example-string",
  "useStaticPriceFilter": "1234.56",
  "minOpenDeal": "example-string",
  "maxOpenDeal": "example-string",
  "useDynamicPriceFilter": "1234.56",
  "dynamicPriceFilterDirection": "1234.56",
  "dynamicPriceFilterOverValue": "1234.56",
  "dynamicPriceFilterUnderValue": "1234.56",
  "dynamicPriceFilterPriceType": "1234.56",
  "useNoOverlapDeals": true,
  "useCooldown": true,
  "cooldownAfterDealStart": true,
  "cooldownAfterDealStartInterval": 0,
  "cooldownAfterDealStartUnits": "seconds",
  "cooldownAfterDealStop": true,
  "cooldownAfterDealStopInterval": 0,
  "cooldownAfterDealStopUnits": "seconds",
  "useTp": true,
  "useSl": true,
  "useDca": true,
  "useSmartOrders": true,
  "activeOrdersCount": 0,
  "useActiveMinigrids": "550e8400-e29b-41d4-a716-446655440000",
  "comboActiveMinigrids": "550e8400-e29b-41d4-a716-446655440000",
  "comboUseSmartGrids": "550e8400-e29b-41d4-a716-446655440000",
  "comboSmartGridsCount": "550e8400-e29b-41d4-a716-446655440000",
  "volumeScale": "example-string",
  "stepScale": "example-string",
  "comboTpBase": "full"
}
```


---

## UpdateComboDealsInput

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ordersCount` | integer | No | DCA orders count |
| `step` | string | No | Step percentage between DCA orders |
| `tpPerc` | string | No | Take profit percent |
| `slPerc` | string | No | Stop loss percent |
| `profitCurrency` | enum: `base|quote` | No | Profit currency |
| `avgPrice` | number | No | Average price of the deal |
| `orderSize` | string | No | DCA order qty of the deal |
| `useTp` | boolean | No | Use take profit |
| `useSl` | boolean | No | Use stop loss |
| `useDca` | boolean | No | Use DCA orders |
| `useSmartOrders` | boolean | No | Use smart orders |
| `activeOrdersCount` | integer | No | Active orders count |
| `volumeScale` | string | No | Volume scale of DCA orders |
| `stepScale` | string | No | Step scale of DCA orders |
| `dealCloseConditionSL` | enum: `tp` | No | Deal close options. For deal only possible option - tp |
| `useMultiSl` | boolean | No | Use multiple SL targets. multiSl array should be provided |
| `multiSl` | Array<object> | No | Multiple SL targets |
| `baseSlOn` | enum: `start|avg` | No | Base SL on. Default - avg |
| `trailingSl` | boolean | No | Use trailing SL. Cannot be checked with active moveSL or multiSl |
| `moveSL` | boolean | No | Use move SL. Cannot be checked with active trailingSl or multiSl. Require moveSLTrigger and moveSLValue |
| `moveSLTrigger` | string | No | Move SL trigger in % |
| `moveSLValue` | string | No | Move SL value in % |
| `dealCloseCondition` | enum: `tp` | No | Deal close options. For deal only possible option - tp |
| `closeByTimer` | boolean | No | Close deal by timer. Require closeByTimerValue and closeByTimerUnits |
| `closeByTimerValue` | integer | No | Close deal by timer value |
| `closeByTimerUnits` | enum: `seconds|minutes|hours|days` | No | Close deal by timer units |
| `useMultiTp` | boolean | No | Use multiple TP targets. multiTp array should be provided |
| `multiTp` | Array<object> | No | Multiple TP targets |
| `trailingTp` | boolean | No | Use trailing TP. Cannot be checked with active multiTp. Require trailingTpPerc |
| `trailingTpPerc` | string | No | Trailing take profit deviation on % |
| `dcaCondition` | enum: `percentage|custom` | No | DCA Type. For deal available options - percentage, custom. Custom required dcaCustom array |
| `dcaCustom` | Array<object> | No | DCA custom objects |

### Example

```json
{
  "ordersCount": 0,
  "step": "example-string",
  "tpPerc": "2.5",
  "slPerc": "2.5",
  "profitCurrency": "base",
  "avgPrice": "1234.56",
  "orderSize": "example-string",
  "useTp": true,
  "useSl": true,
  "useDca": true,
  "useSmartOrders": true,
  "activeOrdersCount": 0,
  "volumeScale": "example-string",
  "stepScale": "example-string",
  "dealCloseConditionSL": "tp",
  "useMultiSl": true,
  "multiSl": [
    {
      "target": "example-string",
      "amount": "1234.56",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "baseSlOn": "start",
  "trailingSl": true,
  "moveSL": true,
  "moveSLTrigger": "example-string",
  "moveSLValue": "example-string",
  "dealCloseCondition": "tp",
  "closeByTimer": "2024-01-15T10:30:00.000Z",
  "closeByTimerValue": "2024-01-15T10:30:00.000Z",
  "closeByTimerUnits": "2024-01-15T10:30:00.000Z",
  "useMultiTp": true,
  "multiTp": [
    {
      "target": "example-string",
      "amount": "1234.56",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "trailingTp": true,
  "trailingTpPerc": "2.5",
  "dcaCondition": "percentage",
  "dcaCustom": [
    {
      "step": "example-string",
      "size": "example-string",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ]
}
```


---

## UpdateDCABotInput

Input schema for updating DCA bot settings

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pair` | Array<string> | No | Trading pairs. In the format {base}_{quote} |
| `name` | string | No | Bot name |
| `step` | string | No | Step percentage between DCA orders |
| `ordersCount` | integer | No | DCA orders count |
| `tpPerc` | string | No | Take profit percent |
| `slPerc` | string | No | Stop loss percent |
| `profitCurrency` | enum: `base|quote` | No | Profit currency |
| `orderSize` | string | No | DCA order qty of the deal. |
| `baseOrderSize` | string | No | Base order qty of the deal. |
| `orderSizeType` | enum: `base|quote|percFree|percTotal|usd` | No | Currency reference |
| `startOrderType` | enum: `limit|market` | No | Currency reference |
| `useRiskReduction` | boolean | No | Use risk reduction. Requires riskReductionValue value |
| `riskReductionValue` | string | No | Risk reduction value in % |
| `useReinvest` | boolean | No | Use reinvest profit. Requires reinvestValue value |
| `reinvestValue` | string | No | Reinvest profit value in % |
| `skipBalanceCheck` | boolean | No | Skip balance check |
| `startCondition` | enum: `ASAP|Manual` | No | Start deal condition |
| `maxNumberOfOpenDeals` | string | No | Max number of open deals |
| `useStaticPriceFilter` | boolean | No | Use static price filter. Require minOpenDeal or maxOpenDeal |
| `minOpenDeal` | string | No | Minimum price for open deal |
| `maxOpenDeal` | string | No | Maximum price for open deal |
| `useDynamicPriceFilter` | boolean | No | Use dynamic price filter. Require dynamicPriceFilterDirection, dynamicPriceFilterOverValue or dynamicPriceFilterUnderValue or both, dynamicPriceFilterPriceType |
| `dynamicPriceFilterDirection` | enum: `over|under|overAndUnder` | No | Direction of the price filter. Over require dynamicPriceFilterOverValue field, under require dynamicPriceFilterUnderValue field, overAndUnder require both fields |
| `dynamicPriceFilterOverValue` | string | No | Over value |
| `dynamicPriceFilterUnderValue` | string | No | Over value |
| `dynamicPriceFilterPriceType` | enum: `avg|entry` | No | Price sourse |
| `useNoOverlapDeals` | boolean | No | Use no overlap deals in dynamic price filter |
| `useCooldown` | boolean | No | Use cooldown |
| `cooldownAfterDealStart` | boolean | No | Use cooldown after deal start. Require cooldownAfterDealStartInterval and cooldownAfterDealStartUnits |
| `cooldownAfterDealStartInterval` | number | No | Cooldown after deal start interval |
| `cooldownAfterDealStartUnits` | enum: `seconds|minutes|hours|days` | No | Cooldown after deal start units |
| `cooldownAfterDealStop` | boolean | No | Use cooldown after deal stop. Require cooldownAfterDealStopInterval and cooldownAfterDealStopUnits |
| `cooldownAfterDealStopInterval` | number | No | Cooldown after deal stop interval |
| `cooldownAfterDealStopUnits` | enum: `seconds|minutes|hours|days` | No | Cooldown after deal stop units |
| `useTp` | boolean | No | Use take profit |
| `useSl` | boolean | No | Use stop loss |
| `useDca` | boolean | No | Use DCA orders |
| `useSmartOrders` | boolean | No | Use smart orders |
| `activeOrdersCount` | integer | No | Active orders count |
| `volumeScale` | string | No | Volume scale of DCA orders |
| `stepScale` | string | No | Step scale of DCA orders |
| `dealCloseConditionSL` | enum: `tp` | No | Deal close options. |
| `useMultiSl` | boolean | No | Use multiple SL targets. multiSl array should be provided. |
| `multiSl` | Array<object> | No | Multiple SL targets. |
| `baseSlOn` | enum: `start|avg` | No | Base SL on. Default - avg. |
| `trailingSl` | boolean | No | Use trailing SL. Cannot be checked with active moveSL or multiSl. |
| `moveSL` | boolean | No | Use move SL. Cannot be checked with active trailingSl or multiSl. Require moveSLTrigger and moveSLValue. |
| `moveSLTrigger` | string | No | Move SL trigger in %. |
| `moveSLValue` | string | No | Move SL value in %. |
| `dealCloseCondition` | enum: `tp` | No | Deal close options. For deal only possible option - tp. |
| `closeByTimer` | boolean | No | Close deal by timer. Require closeByTimerValue and closeByTimerUnits. |
| `closeByTimerValue` | integer | No | Close deal by timer value. |
| `closeByTimerUnits` | enum: `seconds|minutes|hours|days` | No | Close deal by timer units. |
| `useMultiTp` | boolean | No | Use multiple TP targets. multiTp array should be provided. |
| `multiTp` | Array<object> | No | Multiple TP targets. |
| `trailingTp` | boolean | No | Use trailing TP. Cannot be checked with active multiTp. Require trailingTpPerc. |
| `trailingTpPerc` | string | No | Trailing take profit deviation on %. |
| `dcaCondition` | enum: `percentage|custom` | No | DCA Type. For deal available options - percentage, custom. Custom required dcaCustom array. |
| `dcaCustom` | Array<object> | No | DCA custom objects. |

### Example

```json
{
  "pair": [
    "example-string"
  ],
  "name": "BTC/USDT",
  "step": "example-string",
  "ordersCount": 0,
  "tpPerc": "2.5",
  "slPerc": "2.5",
  "profitCurrency": "base",
  "orderSize": "example-string",
  "baseOrderSize": "example-string",
  "orderSizeType": "base",
  "startOrderType": "limit",
  "useRiskReduction": true,
  "riskReductionValue": "example-string",
  "useReinvest": true,
  "reinvestValue": "example-string",
  "skipBalanceCheck": "1234.56",
  "startCondition": "ASAP",
  "maxNumberOfOpenDeals": "example-string",
  "useStaticPriceFilter": "1234.56",
  "minOpenDeal": "example-string",
  "maxOpenDeal": "example-string",
  "useDynamicPriceFilter": "1234.56",
  "dynamicPriceFilterDirection": "1234.56",
  "dynamicPriceFilterOverValue": "1234.56",
  "dynamicPriceFilterUnderValue": "1234.56",
  "dynamicPriceFilterPriceType": "1234.56",
  "useNoOverlapDeals": true,
  "useCooldown": true,
  "cooldownAfterDealStart": true,
  "cooldownAfterDealStartInterval": 0,
  "cooldownAfterDealStartUnits": "seconds",
  "cooldownAfterDealStop": true,
  "cooldownAfterDealStopInterval": 0,
  "cooldownAfterDealStopUnits": "seconds",
  "useTp": true,
  "useSl": true,
  "useDca": true,
  "useSmartOrders": true,
  "activeOrdersCount": 0,
  "volumeScale": "example-string",
  "stepScale": "example-string",
  "dealCloseConditionSL": "tp",
  "useMultiSl": true,
  "multiSl": [
    {
      "target": "example-string",
      "amount": "1234.56",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "baseSlOn": "start",
  "trailingSl": true,
  "moveSL": true,
  "moveSLTrigger": "example-string",
  "moveSLValue": "example-string",
  "dealCloseCondition": "tp",
  "closeByTimer": "2024-01-15T10:30:00.000Z",
  "closeByTimerValue": "2024-01-15T10:30:00.000Z",
  "closeByTimerUnits": "2024-01-15T10:30:00.000Z",
  "useMultiTp": true,
  "multiTp": [
    {
      "target": "example-string",
      "amount": "1234.56",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "trailingTp": true,
  "trailingTpPerc": "2.5",
  "dcaCondition": "percentage",
  "dcaCustom": [
    {
      "step": "example-string",
      "size": "example-string",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ]
}
```


---

## UpdateDCADealsInput

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ordersCount` | integer | No | DCA orders count |
| `step` | string | No | Step percentage between DCA orders |
| `tpPerc` | string | No | Take profit percent |
| `slPerc` | string | No | Stop loss percent |
| `profitCurrency` | enum: `base|quote` | No | Profit currency |
| `avgPrice` | number | No | Average price of the deal |
| `orderSize` | string | No | DCA order qty of the deal |
| `useTp` | boolean | No | Use take profit |
| `useSl` | boolean | No | Use stop loss |
| `useDca` | boolean | No | Use DCA orders |
| `useSmartOrders` | boolean | No | Use smart orders |
| `activeOrdersCount` | integer | No | Active orders count |
| `volumeScale` | string | No | Volume scale of DCA orders |
| `stepScale` | string | No | Step scale of DCA orders |
| `dealCloseConditionSL` | enum: `tp` | No | Deal close options. For deal only possible option - tp |
| `useMultiSl` | boolean | No | Use multiple SL targets. multiSl array should be provided |
| `multiSl` | Array<object> | No | Multiple SL targets |
| `baseSlOn` | enum: `start|avg` | No | Base SL on. Default - avg |
| `trailingSl` | boolean | No | Use trailing SL. Cannot be checked with active moveSL or multiSl |
| `moveSL` | boolean | No | Use move SL. Cannot be checked with active trailingSl or multiSl. Require moveSLTrigger and moveSLValue |
| `moveSLTrigger` | string | No | Move SL trigger in % |
| `moveSLValue` | string | No | Move SL value in % |
| `dealCloseCondition` | enum: `tp` | No | Deal close options. For deal only possible option - tp |
| `closeByTimer` | boolean | No | Close deal by timer. Require closeByTimerValue and closeByTimerUnits |
| `closeByTimerValue` | integer | No | Close deal by timer value |
| `closeByTimerUnits` | enum: `seconds|minutes|hours|days` | No | Close deal by timer units |
| `useMultiTp` | boolean | No | Use multiple TP targets. multiTp array should be provided |
| `multiTp` | Array<object> | No | Multiple TP targets |
| `trailingTp` | boolean | No | Use trailing TP. Cannot be checked with active multiTp. Require trailingTpPerc |
| `trailingTpPerc` | string | No | Trailing take profit deviation on % |
| `dcaCondition` | enum: `percentage|custom` | No | DCA Type. For deal available options - percentage, custom. Custom required dcaCustom array |
| `dcaCustom` | Array<object> | No | DCA custom objects |

### Example

```json
{
  "ordersCount": 0,
  "step": "example-string",
  "tpPerc": "2.5",
  "slPerc": "2.5",
  "profitCurrency": "base",
  "avgPrice": "1234.56",
  "orderSize": "example-string",
  "useTp": true,
  "useSl": true,
  "useDca": true,
  "useSmartOrders": true,
  "activeOrdersCount": 0,
  "volumeScale": "example-string",
  "stepScale": "example-string",
  "dealCloseConditionSL": "tp",
  "useMultiSl": true,
  "multiSl": [
    {
      "target": "example-string",
      "amount": "1234.56",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "baseSlOn": "start",
  "trailingSl": true,
  "moveSL": true,
  "moveSLTrigger": "example-string",
  "moveSLValue": "example-string",
  "dealCloseCondition": "tp",
  "closeByTimer": "2024-01-15T10:30:00.000Z",
  "closeByTimerValue": "2024-01-15T10:30:00.000Z",
  "closeByTimerUnits": "2024-01-15T10:30:00.000Z",
  "useMultiTp": true,
  "multiTp": [
    {
      "target": "example-string",
      "amount": "1234.56",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "trailingTp": true,
  "trailingTpPerc": "2.5",
  "dcaCondition": "percentage",
  "dcaCustom": [
    {
      "step": "example-string",
      "size": "example-string",
      "uuid": "550e8400-e29b-41d4-a716-446655440000"
    }
  ]
}
```


---

