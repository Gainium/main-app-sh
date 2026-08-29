# Gainium API v2.0 - AI Assistant Guide

This comprehensive guide provides everything needed to help users interact with the Gainium API v2.0.

## Overview

Gainium API v2.0 is a REST API for cryptocurrency trading bot management with advanced field selection capabilities that reduce payload sizes by 70-90%.

**Base URL:** `https://api.gainium.io`  
**Version:** 2.0.0  
**Authentication:** HMAC-SHA256 signatures

## Key Features

- **Field Selection**: Choose exactly which fields to return
- **Performance Optimized**: Up to 90% smaller payloads
- **Comprehensive**: Full CRUD operations for bots, deals, balances
- **Real-time**: WebSocket support (separate documentation)
- **Paper Trading**: Full simulation environment

## Authentication

All API requests require three headers:

| Header | Description | Example |
|--------|-------------|---------|
| `token` | Public API key | `your-public-key` |
| `time` | Request timestamp (ms) | `1787972126131` |
| `signature` | HMAC-SHA256 signature | `calculated-signature` |

### Signature Calculation
Signature = `base64(hmac_sha256(secret, body + method + endpoint + timestamp))`

### Python Example
```python
import hmac
import hashlib
import base64
import time
import requests

def create_signature(secret, body, method, endpoint, timestamp):
    message = body + method + endpoint + str(timestamp)
    signature = hmac.new(
        secret.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).digest()
    return base64.b64encode(signature).decode('utf-8')

# Usage
secret = "your-api-secret"
body = "{}"  # JSON string
method = "GET"
endpoint = "/api/v2/bots/dca"
timestamp = int(time.time() * 1000)

signature = create_signature(secret, body, method, endpoint, timestamp)

headers = {
    "token": "your-public-key",
    "time": str(timestamp),
    "signature": signature,
    "Content-Type": "application/json"
}
```

### JavaScript/TypeScript Example
```javascript
const crypto = require('crypto');

function createSignature(secret, body, method, endpoint, timestamp) {
    const message = body + method + endpoint + timestamp;
    return crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('base64');
}

// Usage
const secret = 'your-api-secret';
const body = '{}';
const method = 'GET';
const endpoint = '/api/v2/bots/dca';
const timestamp = Date.now();

const signature = createSignature(secret, body, method, endpoint, timestamp);

const headers = {
    'token': 'your-public-key',
    'time': timestamp.toString(),
    'signature': signature,
    'Content-Type': 'application/json'
};
```

### CLI Example (curl)
```bash
# Calculate signature (requires external script or tool)
TOKEN="your-public-key"
SECRET="your-api-secret"
TIMESTAMP=$(date +%s%3N)
BODY="{}"
METHOD="GET"
ENDPOINT="/api/v2/bots/dca"

# Use online tool or script to generate HMAC-SHA256 signature
SIGNATURE="calculated-signature-here"

curl -X GET "https://api.gainium.io/api/v2/bots/dca?fields=minimal" \
  -H "token: $TOKEN" \
  -H "time: $TIMESTAMP" \
  -H "signature: $SIGNATURE" \
  -H "Content-Type: application/json"
```

## Field Selection

The most powerful feature of API v2.0 is field selection via the `fields` parameter.

### Field Presets

| Preset | Purpose | Payload Reduction |
|--------|---------|-------------------|
| `minimal` | Essential fields only | ~85% |
| `standard` | Common fields (default) | ~70% |
| `extended` | Additional useful fields | ~40% |
| `full` | All available fields | 0% |

### Custom Fields
Use dot notation for nested fields: `settings.name,profit.total,status`

### Examples

**Minimal DCA bots:**
`?fields=minimal` → Returns: `_id, uuid, settings.name, status, exchange`

**Custom selection:**
`?fields=_id,uuid,settings.name,profit.totalUsd,status` → Returns only specified fields

**Nested fields:**
`?fields=settings.name,settings.pair,profit.total,profit.totalUsd`

## Common Usage Patterns

### Get All DCA Bots (Minimal)
```python
import requests

response = requests.get(
    "https://api.gainium.io/api/v2/bots/dca",
    params={"fields": "minimal"},
    headers=headers
)
bots = response.json()["data"]
```

### Get Specific Bot Details
```python
# Get bot with full settings
response = requests.get(
    "https://api.gainium.io/api/v2/bots/dca",
    params={"fields": "extended"},
    headers=headers
)
```

### Filter Active Bots
```python
response = requests.get(
    "https://api.gainium.io/api/v2/bots/dca",
    params={
        "fields": "standard",
        "status": "open",
        "paperContext": "false"
    },
    headers=headers
)
```

### Start a Bot
```python
response = requests.post(
    "https://api.gainium.io/api/v2/bots/start",
    params={
        "botId": "550e8400-e29b-41d4-a716-446655440000",
        "type": "dca"
    },
    headers=headers
)
```

## API Endpoints

All endpoints support field selection via `?fields=minimal|standard|extended|full` parameter.

For detailed schema references, see [SCHEMAS.md](./SCHEMAS.md).

### Backtest

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/backtest/combo/requests/{id}` | Query params only | [BacktestRequestSingleResponse](./SCHEMAS.md#backtestrequestsingleresponse) | Get Combo Backtest Request by ID |
| GET | `/api/v2/backtest/combo/requests` | Query params only | [BacktestRequestListResponse](./SCHEMAS.md#backtestrequestlistresponse) | Get Combo Backtest Requests |
| GET | `/api/v2/backtest/dca/requests/{id}` | Query params only | [BacktestRequestSingleResponse](./SCHEMAS.md#backtestrequestsingleresponse) | Get DCA Backtest Request by ID |
| GET | `/api/v2/backtest/dca/requests` | Query params only | [BacktestRequestListResponse](./SCHEMAS.md#backtestrequestlistresponse) | Get DCA Backtest Requests |
| GET | `/api/v2/backtest/grid/requests/{id}` | Query params only | [BacktestRequestSingleResponse](./SCHEMAS.md#backtestrequestsingleresponse) | Get Grid Backtest Request by ID |
| GET | `/api/v2/backtest/grid/requests` | Query params only | [BacktestRequestListResponse](./SCHEMAS.md#backtestrequestlistresponse) | Get Grid Backtest Requests |
| POST | `/api/v2/backtest/combo/estimate-cost` | Request body | [BacktestCostEstimate](./SCHEMAS.md#backtestcostestimate) | Estimate Combo Bot Backtest Cost |
| POST | `/api/v2/backtest/dca/estimate-cost` | Request body | [BacktestCostEstimate](./SCHEMAS.md#backtestcostestimate) | Estimate DCA Bot Backtest Cost |
| POST | `/api/v2/backtest/grid/estimate-cost` | Request body | [BacktestCostEstimate](./SCHEMAS.md#backtestcostestimate) | Estimate Grid Bot Backtest Cost |
| POST | `/api/v2/backtest/combo/request` | Request body | [BacktestResponse](./SCHEMAS.md#backtestresponse) | Request Combo Bot Server Side Backtest |
| POST | `/api/v2/backtest/combo/request/sync` | Request body | [BacktestResponse](./SCHEMAS.md#backtestresponse) | Request Combo Backtest (Synchronous) |
| POST | `/api/v2/backtest/dca/request` | Request body | [BacktestResponse](./SCHEMAS.md#backtestresponse) | Request DCA Bot Server Side Backtest |
| POST | `/api/v2/backtest/dca/request/sync` | Request body | [BacktestResponse](./SCHEMAS.md#backtestresponse) | Request DCA Backtest (Synchronous) |
| POST | `/api/v2/backtest/grid/request` | Request body | [BacktestResponse](./SCHEMAS.md#backtestresponse) | Request Grid Bot Server Side Backtest |
| POST | `/api/v2/backtest/grid/request/sync` | Request body | [BacktestResponse](./SCHEMAS.md#backtestresponse) | Request Grid Backtest (Synchronous) |
| POST | `/api/v2/backtest/{botType}/validate` | Request body | Success response | Validate bot settings without creating a bot or backtest |

### Bots - Combo

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/bots/combo/details` | Query params | [ComboBot](./SCHEMAS.md#combobot) | Get Combo Bot by ID |
| GET | `/api/v2/bots/combo` | Query params | [ComboBotListResponse](./SCHEMAS.md#combobotlistresponse) | Get Combo Bots |
| POST | `/api/v2/bots/combo` | [CreateComboBotInput](./SCHEMAS.md#createcombobotinput) | Success response | Create Combo Bot |
| POST | `/api/v2/bots/combo/{botId}/clone` | [UpdateComboBotInput](./SCHEMAS.md#updatecombobotinput) | Success response | Clone Combo Bot |
| POST | `/api/v2/bots/combo/{botId}/restore` | Query params only | Success response | Restore Combo Bot |
| POST | `/api/v2/bots/combo/{botId}/start` | Query params only | Success response | Start Combo Bot |
| POST | `/api/v2/bots/combo/{botId}/stop` | Query params only | Success response | Stop Combo Bot |
| PUT | `/api/v2/bots/combo/{botId}` | [UpdateComboBotInput](./SCHEMAS.md#updatecombobotinput) | Success response | Update Combo Bot |
| DELETE | `/api/v2/bots/combo/{botId}` | Query params only | Success response | Archive Combo Bot |

### Deals - Combo

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/deals/combo/details` | Query params | [Deal](./SCHEMAS.md#deal) | Get Combo Deal by ID |
| GET | `/api/v2/deals/combo` | Query params | [DealListResponse](./SCHEMAS.md#deallistresponse) | Get Combo Deals |
| POST | `/api/v2/deals/combo/{botId}/start` | Query params only | Success response | Start New Combo Deal |
| PUT | `/api/v2/deals/combo/{dealId}` | [UpdateComboDealsInput](./SCHEMAS.md#updatecombodealsinput) | Success response | Update Combo Deal |
| DELETE | `/api/v2/deals/combo/{dealId}` | Query params | Success response | Close Combo Deal |

### Bots - DCA

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/bots/dca/details` | Query params | [DCABot](./SCHEMAS.md#dcabot) | Get DCA Bot by ID |
| GET | `/api/v2/bots/dca` | Query params | [DCABotListResponse](./SCHEMAS.md#dcabotlistresponse) | Get DCA Bots |
| POST | `/api/v2/bots/dca` | [CreateDCABotInput](./SCHEMAS.md#createdcabotinput) | Success response | Create DCA Bot |
| POST | `/api/v2/bots/dca/{botId}/clone` | [UpdateDCABotInput](./SCHEMAS.md#updatedcabotinput) | Success response | Clone DCA Bot |
| POST | `/api/v2/bots/dca/{botId}/restore` | Query params only | Success response | Restore DCA Bot |
| POST | `/api/v2/bots/dca/{botId}/start` | Query params only | Success response | Start DCA Bot |
| POST | `/api/v2/bots/dca/{botId}/stop` | Query params only | Success response | Stop DCA Bot |
| PUT | `/api/v2/bots/dca/{botId}/pairs` | Request body | Success response | Change DCA Bot Trading Pairs |
| PUT | `/api/v2/bots/dca/{botId}` | [UpdateDCABotInput](./SCHEMAS.md#updatedcabotinput) | Success response | Update DCA Bot |
| DELETE | `/api/v2/bots/dca/{botId}` | Query params only | Success response | Archive DCA Bot |

### Deals - DCA

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/deals/dca/details` | Query params | [Deal](./SCHEMAS.md#deal) | Get DCA Deal by ID |
| GET | `/api/v2/deals/dca` | Query params | [DealListResponse](./SCHEMAS.md#deallistresponse) | Get DCA Deals |
| POST | `/api/v2/deals/dca/add-funds` | [AddFundsSchema](./SCHEMAS.md#addfundsschema) | Success response | Add Funds to Deal |
| POST | `/api/v2/deals/dca/reduce-funds` | [AddFundsSchema](./SCHEMAS.md#addfundsschema) | Success response | Reduce Funds from Deal |
| POST | `/api/v2/deals/dca/{botId}/start` | Query params | Success response | Start New DCA Deal |
| PUT | `/api/v2/deals/dca/{dealId}` | [UpdateDCADealsInput](./SCHEMAS.md#updatedcadealsinput) | Success response | Update DCA Deal |
| DELETE | `/api/v2/deals/dca/{dealId}` | Query params | Success response | Close DCA Deal |

### Discovery

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/discovery/bots/{botType}` | Query params | Success response | Get schema definition for a single bot type |
| GET | `/api/v2/discovery/bots/{botType}/sections` | Query params only | Array<[SectionSummary](./SCHEMAS.md#sectionsummary)> | List sections for a bot type |
| GET | `/api/v2/discovery/bots` | Query params only | Array<[BotSchemaDefinition](./SCHEMAS.md#botschemadefinition)> | List all bot schema definitions |
| GET | `/api/v2/discovery/indicators/{type}` | Query params | [IndicatorDefinition](./SCHEMAS.md#indicatordefinition) | Get full field definition for an indicator type |
| GET | `/api/v2/discovery/indicators` | Query params | Array<[IndicatorSummary](./SCHEMAS.md#indicatorsummary)> | List all indicator types |

### Bots - Grid

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/bots/grid/details` | Query params | [GridBot](./SCHEMAS.md#gridbot) | Get Grid Bot by ID |
| GET | `/api/v2/bots/grid` | Query params | [GridBotListResponse](./SCHEMAS.md#gridbotlistresponse) | Get Grid Bots |
| POST | `/api/v2/bots/grid` | [CreateGridBotInput](./SCHEMAS.md#creategridbotinput) | Success response | Create Grid Bot |
| POST | `/api/v2/bots/grid/{botId}/clone` | [CreateGridBotInput](./SCHEMAS.md#creategridbotinput) | Success response | Clone Grid Bot |
| POST | `/api/v2/bots/grid/{botId}/restore` | Query params only | Success response | Restore Grid Bot |
| POST | `/api/v2/bots/grid/{botId}/start` | Query params only | Success response | Start Grid Bot |
| POST | `/api/v2/bots/grid/{botId}/stop` | Query params only | Success response | Stop Grid Bot |
| DELETE | `/api/v2/bots/grid/{botId}` | Query params only | Success response | Archive Grid Bot |

### Bots - Hedge

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/bots/hedgeCombo/details` | Query params | [HedgeBotExtended](./SCHEMAS.md#hedgebotextended) | Get HedgeCombo Bot by ID |
| GET | `/api/v2/bots/hedgeCombo` | Query params | [HedgeBotListResponse](./SCHEMAS.md#hedgebotlistresponse) | Get HedgeCombo Bots |
| GET | `/api/v2/bots/hedgeDca/details` | Query params | [HedgeBotExtended](./SCHEMAS.md#hedgebotextended) | Get HedgeDca Bot by ID |
| GET | `/api/v2/bots/hedgeDca` | Query params | [HedgeBotListResponse](./SCHEMAS.md#hedgebotlistresponse) | Get HedgeDca Bots |
| POST | `/api/v2/bots/hedgeCombo/{botId}/clone` | [HedgeCloneInput](./SCHEMAS.md#hedgecloneinput) | Success response | Clone HedgeCombo Bot |
| POST | `/api/v2/bots/hedgeDca/{botId}/clone` | [HedgeCloneInput](./SCHEMAS.md#hedgecloneinput) | Success response | Clone HedgeDca Bot |
| POST | `/api/v2/bots/hedgeCombo/{botId}/restore` | Query params only | Success response | Restore HedgeCombo Bot |
| POST | `/api/v2/bots/hedgeDca/{botId}/restore` | Query params only | Success response | Restore HedgeDca Bot |
| POST | `/api/v2/bots/hedgeCombo/{botId}/start` | [HedgeStartInput](./SCHEMAS.md#hedgestartinput) | Success response | Start HedgeCombo Bot |
| POST | `/api/v2/bots/hedgeDca/{botId}/start` | [HedgeStartInput](./SCHEMAS.md#hedgestartinput) | Success response | Start HedgeDca Bot |
| POST | `/api/v2/bots/hedgeCombo/{botId}/stop` | Query params | Success response | Stop HedgeCombo Bot |
| POST | `/api/v2/bots/hedgeDca/{botId}/stop` | Query params | Success response | Stop HedgeDca Bot |
| DELETE | `/api/v2/bots/hedgeCombo/{botId}` | Query params only | Success response | Archive HedgeCombo Bot |
| DELETE | `/api/v2/bots/hedgeDca/{botId}` | Query params only | Success response | Archive HedgeDca Bot |

### General

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/screener` | Query params | [ScreenerListResponse](./SCHEMAS.md#screenerlistresponse) | Get Crypto Screener Data |
| GET | `/api/v2/exchanges` | Query params only | [ExchangeGeneralListResponse](./SCHEMAS.md#exchangegenerallistresponse) | Get Supported Exchanges |

### Terminal

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/deals/terminal/details` | Query params | [Deal](./SCHEMAS.md#deal) | Get Terminal Deal by ID |
| GET | `/api/v2/deals/terminal` | Query params | [DealListResponse](./SCHEMAS.md#deallistresponse) | Get Terminal Deals |
| POST | `/api/v2/deals/terminal` | [CreateTerminalDealInput](./SCHEMAS.md#createterminaldealinput) | Success response | Create Terminal Deal |
| POST | `/api/v2/deals/terminal/{dealId}/add-funds` | [AddFundsSchema](./SCHEMAS.md#addfundsschema) | Success response | Add Funds to Terminal Deal |
| POST | `/api/v2/deals/terminal/{dealId}/reduce-funds` | [AddFundsSchema](./SCHEMAS.md#addfundsschema) | Success response | Reduce Funds from Terminal Deal |
| PUT | `/api/v2/deals/terminal/{dealId}` | [UpdateDCADealsInput](./SCHEMAS.md#updatedcadealsinput) | Success response | Update Terminal Deal Settings |
| DELETE | `/api/v2/deals/terminal/{dealId}` | Query params | Success response | Close Terminal Deal |

### User

| Method | URL | Input Schema | Response | Description |
|--------|-----|--------------|----------|-------------|
| GET | `/api/v2/user/balances` | Query params | [BalanceListResponse](./SCHEMAS.md#balancelistresponse) | Get Balances |
| GET | `/api/v2/user/exchanges` | Query params only | [ExchangeListResponse](./SCHEMAS.md#exchangelistresponse) | Get Exchanges |
| GET | `/api/v2/user/global-vars` | Query params | [GlobalVariableListResponse](./SCHEMAS.md#globalvariablelistresponse) | Get Global Variables |
| POST | `/api/v2/user/global-vars` | Request body | Success response | Create Global Variable |
| PUT | `/api/v2/user/global-vars/{id}` | Request body | Success response | Update Global Variable |
| DELETE | `/api/v2/user/global-vars/{id}` | Query params only | Success response | Delete Global Variable |



## Error Handling

### Response Structure
```json
{
  "status": "NOTOK",
  "reason": "Error description"
}
```

### Common HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 400 | Bad Request | Check parameters and request format |
| 401 | Unauthorized | Verify authentication headers |
| 403 | Forbidden | Check API key permissions |
| 404 | Not Found | Verify endpoint URL and resource ID |
| 429 | Rate Limited | Implement backoff and retry |
| 500 | Server Error | Contact support if persists |

### Python Error Handling
```python
try:
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    data = response.json()
    
    if data["status"] == "NOTOK":
        print(f"API Error: {data['reason']}")
    else:
        return data["data"]
        
except requests.exceptions.RequestException as e:
    print(f"Request failed: {e}")
```

## Pagination

All list endpoints support pagination:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | 1 | Page number (1-based) |

### Response Structure
```json
{
  "status": "OK",
  "reason": null,
  "data": [...],
  "meta": {
    "page": 1,
    "total": 150,
    "count": 150,
    "onPage": 10,
    "fields": ["_id", "uuid", "settings.name"]
  }
}
```

### Python Pagination Example
```python
def get_all_bots():
    all_bots = []
    page = 1
    
    while True:
        response = requests.get(
            "https://api.gainium.io/api/v2/bots/dca",
            params={"page": page, "fields": "minimal"},
            headers=headers
        )
        data = response.json()
        
        all_bots.extend(data["data"])
        
        # Check if we have more pages
        if len(data["data"]) < 10:  # Fixed page size
            break
        page += 1
    
    return all_bots
```

---

*This documentation is automatically generated from the OpenAPI specification.*  
*Last updated: 2026-08-29T02:55:26.133Z*  
*For detailed schemas, see [SCHEMAS.md](./SCHEMAS.md)*

## Schemas

For detailed schema definitions with field descriptions and examples, see [SCHEMAS.md](./SCHEMAS.md).

### Quick Schema Reference

| Schema | Purpose |
|--------|---------|
| DCABotSettings | DCA bot configuration |
| ComboBotSettings | Combo bot configuration |
| GridBotSettings | Grid bot configuration |
| BotSettings | Base bot settings |
| DealSettings | Deal configuration |
| SettingsIndicators | Technical indicators |
| MultiTP | Multiple take-profit settings |
| DCACustom | Custom DCA configuration |