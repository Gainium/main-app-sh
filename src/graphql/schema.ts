export const BasicSchema = /* GraphQL */ `
  scalar Date
  scalar StringOrArrayOfStrings
  scalar StringOrNumber
  scalar FloatOrInfinity
  scalar BacktestDataInput
  enum Status {
    OK
    NOTOK
  }
  enum ThemeMode {
    dark
    light
  }
  interface BasicResponse {
    status: Status
    reason: String
  }
  type Query {
    getUsdRate: getUsdRateResponse
    getPairInfo(input: getPairInput!): getPairResponse
    getAllPairs: getAllPairsResponse
  }
  type getUsdRateResponse implements BasicResponse {
    status: Status
    reason: String
    data: Float
  }
  input getPairInput {
    pair: String!
    exchange: Exchange!
  }
  type baseAssetPair {
    minAmount: Float
    maxAmount: Float
    step: Float
    name: String
    displayName: String
    maxMarketAmount: Float
  }
  type quoteAssetPair {
    minAmount: Float
    name: String
  }
  type pairInfo {
    wsCode: String
    code: String
    pair: String
    exchange: Exchange
    baseAsset: baseAssetPair
    quoteAsset: quoteAssetPair
    maxOrders: Int
    priceAssetPrecision: Float
    crossAvailable: Boolean
    assetCategory: String
    isCanonical: Boolean
    source: String
  }
  type getPairResponse implements BasicResponse {
    status: Status
    reason: String
    data: pairInfo
  }
  type getAllPairsResponse implements BasicResponse {
    status: Status
    reason: String
    data: allPairInfo
  }
  type baseAssetInPair {
    minAmount: Float
    step: Float
    maxAmount: Float
    name: String
    displayName: String
    maxMarketAmount: Float
  }
  type quoteAssetInPair {
    minAmount: Float
    name: String
  }
  type pairDetailedInfo {
    wsCode: String
    code: String
    pair: String
    exchange: Exchange
    baseAsset: baseAssetInPair
    quoteAsset: quoteAssetInPair
    maxOrders: Float
    priceAssetPrecision: Float
    crossAvailable: Boolean
    assetCategory: String
    isCanonical: Boolean
    source: String
  }
  type allPairInfo {
    result: [pairDetailedInfo]
  }
  input DataGridFilterInput {
    page: Float
    pageSize: Float
    sortModel: [GridSortItem]
    filterModel: GridFilterModel
  }
`

const UserForm = /* GraphQL */ `
  type Query {
    checkUserExist: checkUserExistResponse
  }
  type Mutation {
    setLicenseKey(input: setLicenseKeyInput!): setLicenseKeyResponse
    deleteLicenseKey: setLicenseKeyResponse
    registerAccount(input: registerAccountInput!): tokenResponse
  }
  type checkUserExistResponse implements BasicResponse {
    status: Status
    reason: String
    data: Boolean
  }
  input setLicenseKeyInput {
    key: String!
  }
  type setLicenseKeyResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input registerAccountInput {
    email: String!
    password: String!
    picture: String
    lastName: String
    name: String
    timezone: String!
    weekStart: String
    licenseKey: String!
  }
`

const UserResponse = /* GraphQL */ `
  type Query {
    user: userResponse
  }
`

export const AddExchangeInput = /* GraphQL */ `
  # Per-sub-account paper top-up. A "SPOT & Futures" (tradeType: all)
  # create spawns one paper account per market (SPOT, USDⓈ-M, COIN-M);
  # an optional topUps entry funds each independently, keyed by the
  # created account's own provider. When topUps is omitted the legacy
  # single coinToTopUp/stablecoinBalance is used for every account, so
  # existing callers are unaffected.
  input paperTopUpInput {
    provider: Exchange!
    asset: String!
    amount: Float!
  }

  input addExchangeInput {
    key: String!
    secret: String!
    provider: Exchange!
    name: String
    passphrase: String
    stablecoinBalance: Float
    coinToTopUp: String
    tradeType: TradeTypeEnum
    topUps: [paperTopUpInput!]
    keysType: String
    okxSource: String
    bybitHost: BybitHost
    subaccount: Boolean
    shouldCheckAffiliate: Boolean
  }
`

export const UserSchema = /* GraphQL */ `
  type Query {
    getUserFiles: getUserFilesResponse
    getExchange(input: getExchangeInput!): exchangeResponse
    userFee(input: userFeeInput!): userFeeResponse
    multipleUserFees(input: multipleUserFeesInput!): multipleUserFeesResponse
    getBalances(input: getBalancesInput!): getBalancesResponse
    updateBalance(input: updateBalanceInput): getPortfolioResponse
    updateStatus: updateStatusResponse
    getUserPeriods: getUserPeriodsResponse
    getUserFavoritePairs: userFavoritePairsResponse
    getUserFavoriteIndicators: userFavoriteIndicatorsResponse
    getSnapshotPerExchange(
      input: getSnapshotPerExchangeInput
    ): getSnapshotPerExchangeResponse
    activeSessions: activeSessionsResponse
  }
  type Mutation {
    resetAccount(input: resetAccountInput!): resetAccountResponse
    removeUserFiles(input: removeUserFilesInput!): removeUserFilesResponse
    token(input: tokenInput!): tokenResponse
    setTimezone(input: setTimezoneInput!): setTimezoneResponse
    addExchange(input: addExchangeInput!): addExchangeResponse
    updateExchange(input: updateExchangeInput!): exchangeResponse
    deleteExchange(input: deleteExchangeInput!): deleteExchangeResponse
    userSettings(input: userSettingsInput!): userSettingsResponse
    deleteToken: deleteTokenResponse
    revokeSession(input: revokeSessionInput!): deleteTokenResponse
    logoutOtherSessions: deleteTokenResponse
    updateProfilePicture(
      input: updateProfilePictureInput!
    ): updateProfilePictureResponse
    createAPIKeys: createAPIKeysResponse
    renewAPIKeys(input: apiKeysInput!): renewAPIKeysResponse
    changeAPIKeysPermission(
      input: changeAPIKeysPermissionInput!
    ): renewAPIKeysResponse
    changeAPIKeysName(input: changeAPIKeysNameInput!): renewAPIKeysResponse
    changeAPIKeysPaperContext(
      input: changeAPIKeysPaperContextInput!
    ): renewAPIKeysResponse
    changeAPIKeysBotId(input: changeAPIKeysBotIdInput!): renewAPIKeysResponse
    deleteAPIKeys(input: apiKeysInput!): renewAPIKeysResponse
    changePassword(input: changePasswordInput!): changePasswordResponse
    saveUserPeriod(input: userPeriodInput!): getUserPeriodsResponse
    updateUserPeriod(input: updatePeriodInput!): getUserPeriodsResponse
    deleteUserPeriod(input: deletePeriodInput!): getUserPeriodsResponse
    addUserFavoritePair(input: favoritePairInput!): favoritePairsResponse
    removeUserFavoritePair(input: favoritePairInput!): favoritePairsResponse
    addUserFavoriteIndicator(
      input: favoriteIndicatorInput!
    ): userFavoriteIndicatorsResponse
    removeUserFavoriteIndicator(
      input: favoriteIndicatorInput!
    ): userFavoriteIndicatorsResponse
    setHedge(input: setHedgeInput!): setHedgeResponse
    setZeroFee(input: setZeroFeeInput!): setHedgeResponse
    setVideoUpdate(input: setVideoUpdateInput!): setVideoUpdateResponse
  }
  input getSnapshotPerExchangeInput {
    uuid: String
    from: Float
    to: Float
  }
  type getSnapshotPerExchangeResponseDataResult {
    userId: String
    updateTime: Float
    totalUsd: Float
    uuid: String
    paperContext: Boolean
  }
  type getSnapshotPerExchangeResponseData {
    result: [getSnapshotPerExchangeResponseDataResult]
  }
  type getSnapshotPerExchangeResponse implements BasicResponse {
    status: Status
    reason: String
    data: getSnapshotPerExchangeResponseData
  }

  enum resetAccountTypeEnum {
    paper
    live
    whole
  }
  input resetAccountInput {
    type: resetAccountTypeEnum
  }
  type resetAccountResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type updateStatusResponse implements BasicResponse {
    status: Status
    reason: String
    data: [exchangeResponseData]
  }
  input removeUserFilesInput {
    files: [String]
  }
  scalar MetaScalar
  type userFile {
    meta: MetaScalar
    size: Float
    id: String
  }
  type removeUserFilesResponse implements BasicResponse {
    status: Status
    reason: String
    data: [String]
  }
  type getUserFilesResponse implements BasicResponse {
    status: Status
    reason: String
    data: [userFile]
  }
  input setVideoUpdateInput {
    id: String!
    watch80: Boolean
    closed: Boolean
  }
  type setVideoUpdateResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input setHedgeInput {
    hedge: Boolean!
    uuid: String!
  }
  input setZeroFeeInput {
    value: Boolean!
    uuid: String!
  }
  type setHedgeResponse implements BasicResponse {
    status: Status
    reason: String
    data: Boolean
  }
  input updateBalanceInput {
    skipSnapshot: Boolean
    # Refresh only this exchange's balances from the venue (snapshot totals
    # are still recomputed). Omit to re-fetch every exchange.
    uuid: String
  }
  input userPeriodInput {
    name: String
    from: Float
    to: Float
    uuid: String
  }
  input updatePeriodInput {
    name: String
    from: Float
    to: Float
    uuid: String!
  }
  input deletePeriodInput {
    uuid: String!
  }
  input favoritePairInput {
    provider: Exchange!
    pair: String!
  }
  input favoriteIndicatorInput {
    indicator: IndicatorsEnum!
  }
  type favoritePairsResponse implements BasicResponse {
    status: Status
    reason: String
    data: favoritePairs
  }
  type userFavoritePairsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [favoritePairs]
  }
  type userFavoriteIndicatorsResponse implements BasicResponse {
    status: Status
    reason: String
    data: favoriteIndicators
  }
  type favoriteIndicators {
    indicators: [IndicatorsEnum]
  }
  type favoritePairs {
    provider: Exchange
    pairs: [String]
  }
  type getUserPeriodsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [userPeriod]
  }
  type userPeriod {
    name: String
    from: Float
    to: Float
    _id: String
    uuid: String
  }
  input changePasswordInput {
    password: String!
  }
  type changePasswordResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input tokenInput {
    username: String!
    password: String!
  }
  type tokenData {
    token: String
    isOTP: Boolean
    shouldOnBoard: Boolean
    shouldOnBoardExchange: Boolean
  }
  input changeAPIKeysPermissionInput {
    key: String
    permission: APIPermission
  }
  input changeAPIKeysNameInput {
    key: String
    name: String
  }
  input changeAPIKeysPaperContextInput {
    key: String!
    paperContext: Boolean
  }
  input changeAPIKeysBotIdInput {
    key: String!
    botId: String
  }
  type renewAPIKeysResponse implements BasicResponse {
    status: Status
    reason: String
    data: [userAPIKeys]
  }
  type tokenResponse implements BasicResponse {
    status: Status
    reason: String
    data: tokenData
  }
  input apiKeysInput {
    key: String!
  }
  type APIKeys {
    _id: String
    secret: String
    name: String
    created: Date
    expired: Date
    permission: APIPermission
    paperContext: Boolean
    botId: String
  }
  type createAPIKeysResponse implements BasicResponse {
    status: Status
    reason: String
    data: APIKeys
  }
  type tokenType {
    token: String
    createdAt: Date
    expiredAt: Date
  }
  enum APIPermission {
    read
    write
  }
  type userAPIKeys {
    _id: String
    created: Date
    expired: Date
    permission: APIPermission
    name: String
    paperContext: Boolean
    botId: String
    oauthClientId: String
  }
  type user {
    _id: String
    username: String
    bigAccount: Boolean
    password: String
    updated: Date
    created: Date
    tokens: [tokenType]
    timezone: String
    theme: ThemeMode
    weekStart: String
    name: String
    lastName: String
    picture: String
    exchanges: [exchangeResponseData]
    hasExchanges: Boolean
    hasPaperExchanges: Boolean
    hasLiveExchanges: Boolean
    paperContext: Boolean
    apiKeys: [userAPIKeys]
    shouldOnBoard: Boolean
    shouldOnBoardExchange: Boolean
    videos: [userVideos]
    onboardingSteps: userOnboardingSteps
    groups: [String]
    licenseKey: userDataLicenseKey
  }
  type userDataLicenseKey {
    key: String
    isPremium: Boolean
  }
  type userOnboardingSteps {
    signup: Boolean
    liveExchange: Boolean
    deployLiveBot: Boolean
    earnProfit: Boolean
  }
  type userVideos {
    id: String
    watch80: Boolean
    closed: Boolean
  }
  type userResponse implements BasicResponse {
    status: Status
    reason: String
    data: user
  }
  input getExchangeInput {
    uuid: String!
  }
  enum TradeTypeEnum {
    all
    margin
    spot
    futures
  }
  enum BybitHost {
    eu
    com
    nl
    tr
    kz
    ge
  }

  input updateExchangeInput {
    uuid: String!
    key: String
    secret: String
    name: String
    passphrase: String
    stablecoinBalance: Float
    coinToTopUp: String
    keysType: String
    okxSource: String
    bybitHost: BybitHost
    subaccount: Boolean
  }
  type exchangeResponse implements BasicResponse {
    status: Status
    reason: String
    data: exchangeResponseData
  }
  type addExchangeResponse implements BasicResponse {
    status: Status
    reason: String
    data: [exchangeResponseData]
  }
  type clearPaperResponse implements BasicResponse {
    status: Status
    reason: String
  }
  """
  What the exchange last told us this API key is allowed to do. Gainium only
  ever needs read + trade; withdrawal is never required. Every field is
  tri-state — "unknown" means we could not read it, which is NOT "no".
  """
  type exchangeKeyPermissions {
    """
    yes | no | unknown
    """
    withdraw: String
    """
    Internal same-exchange transfers. yes | no | unknown
    """
    transfer: String
    """
    Whether the key is bound to an IP allowlist. yes | no | unknown
    """
    ipRestricted: String
    ips: [String]
    """
    ms epoch of the observation; null when never checked.
    """
    checkedAt: Float
  }
  type exchangeResponseData {
    key: String
    provider: Exchange
    name: String
    uuid: String
    status: Boolean
    hedge: Boolean
    zeroFee: Boolean
    subaccount: Boolean
    linkedTo: String
    balance: Float
    keysType: String
    okxSource: String
    bybitHost: BybitHost
    affiliate: Boolean
    updateTime: Float
    lastUpdated: Float
    waitingForConfirmation: Boolean
    """
    Null when this connection has never been checked. The raw permission
    detail string is deliberately not exposed here — it is admin-forensics
    text, not user-facing copy.
    """
    keyPermissions: exchangeKeyPermissions
    """
    True while this connection is still on a credential the operator has asked
    the user to replace. Drives the "Replace key" chip on the Exchanges and
    Portfolio pages. Always false unless an operator has flagged the
    connection.
    """
    rotationRequired: Boolean
  }
  type deleteExchangeResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input deleteExchangeInput {
    uuid: String!
  }
  input setTimezoneInput {
    timezone: String!
    weekStart: String!
  }
  type setTimezoneResponse implements BasicResponse {
    status: Status
    reason: String
  }
  type userSettingsResponse implements BasicResponse {
    status: Status
    reason: String
  }
  type deleteTokenResponse implements BasicResponse {
    status: Status
    reason: String
  }
  type userSession {
    id: String
    source: String
    device: String
    ip: String
    location: String
    createdAt: String
    expiredAt: String
    current: Boolean
  }
  type activeSessionsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [userSession]
  }
  input revokeSessionInput {
    id: String!
  }
  input userFeeInput {
    uuid: String!
    symbol: String!
  }
  input multipleUserFeesInput {
    uuid: String!
    symbol: [String!]!
  }
  type userFeeData {
    symbol: String
    makerCommission: String
    takerCommission: String
  }
  type multipleUserFeesData {
    symbol: String
    maker: Float
    taker: Float
  }
  type userFeeResponse implements BasicResponse {
    status: Status
    reason: String
    data: userFeeData
  }
  type multipleUserFeesResponse implements BasicResponse {
    status: Status
    reason: String
    data: [multipleUserFeesData]
  }
  input updateProfilePictureInput {
    picture: String!
  }
  type updateProfilePictureResponse implements BasicResponse {
    status: Status
    reason: String
  }
  input getBalancesInput {
    uuid: String
    assets: [String]
    shouldSumBalance: Boolean
  }
  type getBalancesResponseData {
    asset: String
    free: String
    locked: String
    exchange: String
    exchangeUUID: String
    exchangeName: String
  }
  type getBalancesResponse {
    status: Status
    reason: String
    data: [getBalancesResponseData]
  }
  input userSettingsInput {
    timezone: String
    theme: ThemeMode
    paperContext: Boolean
    shouldOnBoard: Boolean
    shouldOnBoardExchange: Boolean
    name: String
    lastName: String
    nickname: String
  }
`

export const BotSchema = /* GraphQL */ `
  type Query {
    searchByBotName(input: searchByBotNameInput!): searchByBotNameResponse
    getServerSideBacktestRequests(
      input: getServerSideBacktestRequestsInput
    ): getServerSideBacktestRequestsResponse
    botList(input: getDcaBotListInput): botListResponse
    botDashboardStats(input: botDashboardStatsInput!): botDashboardStatsResponse
    dealDashboardStats(
      input: dealDashboardStatsInput!
    ): dealDashboardStatsResponse
    dcaBotList(input: getDcaBotListInput): dcaBotListResponse
    comboBotList(input: getDcaBotListInput): comboBotListResponse
    hedgeComboBotList(input: getDcaBotListInput): hedgeComboBotListResponse
    hedgeDCABotList(input: getDcaBotListInput): hedgeComboBotListResponse
    dcaDealList(input: getDcaDealListInput): getDCADealsResponse
    comboDealList(input: getDcaDealListInput): getComboDealsResponse
    hedgeComboDealList(input: getDcaDealListInput): getComboDealsResponse
    hedgeDcaDealList(input: getDcaDealListInput): getDCADealsResponse
    getBot(input: getBotInput!): getBotResponse
    getDCABot(input: getBotInput!): getDCABotResponse
    getComboBot(input: getBotInput!): getComboBotResponse
    getHedgeComboBot(input: getBotInput!): getHedgeComboBotResponse
    getHedgeDCABot(input: getBotInput!): getHedgeComboBotResponse
    getDCADeals(input: getDCADealsInput): getDCADealsResponse
    getComboDeals: getComboDealsResponse
    getHedgeComboDeals: getComboDealsResponse
    getHedgeDcaDeals: getComboDealsResponse
    getBotOrders(input: getBotOrdersInput!): botOrdersResponse
    getDealOrders(input: getDealOrdersInput!): dealOrdersResponse
    getComboDealOrders(input: getDealOrdersInput!): dealOrdersResponse
    getHedgeComboDealOrders(input: getDealOrdersInput!): dealOrdersResponse
    getHedgeDCADealOrders(input: getDealOrdersInput!): dealOrdersResponse
    getBotTransactions(input: getBotTransactionsInput!): botTransactionsResponse
    getBotDeals(input: getBotDealsInput): botDealsResponse
    getComboBotDeals(input: getBotDealsInput): botComboDealsResponse
    getHedgeComboBotDeals(input: getBotDealsInput): botComboDealsResponse
    getHedgeDcaBotDeals(input: getBotDealsInput): botComboDealsResponse
    getComboBotDealsById(
      input: getComboBotDealsByIdInput
    ): botComboDealsResponse
    getDCABotDealsById(input: getComboBotDealsByIdInput): botDealsResponse
    getBotDealsStats(input: getBotDealsStatsInput): botDealsStatsResponse
    getComboBotDealsStats(input: getBotDealsStatsInput): botDealsStatsResponse
    getHedgeComboBotDealsStats(
      input: getBotDealsStatsInput
    ): botDealsStatsResponse
    getHedgeDCABotDealsStats(
      input: getBotDealsStatsInput
    ): botDealsStatsResponse
    getComboBotMinigrids(input: getBotDealsInput): minigridReponse
    getHedgeComboBotMinigrids(input: getBotDealsInput): minigridReponse
    getProfitByBot(input: getProfitByBot!): getProfitResponse
    getProfitByUser(input: getProfitByUser): getProfitResponse
    getLatestOrders(input: getLatestOrdersInput): getLatestOrdersResponse
    getPortfolioByUser(input: getPortfolioByUser): getPortfolioResponse
    getMessageBot(input: getMessageBotInput): botMessageGetResponse
    getQuantRulesStatus: quantRulesStatusResponse
    resetDealSettings(input: resetDealSettingsInput): resetDealSettingsResponse
    resetComboDealSettings(
      input: resetDealSettingsInput
    ): resetDealSettingsResponse
    getTradingTerminalBotsList: getTradingTerminalBotsListResponse
    restartBot(input: restartBotInput!): restartResponse
    getBacktests(input: DataGridFilterInput): getBacktestsResponse
    getComboBacktests(input: DataGridFilterInput): getComboBacktestsResponse
    getHedgeComboBacktests(
      input: DataGridFilterInput
    ): getHedgeComboBacktestsResponse
    getHedgeDCABacktests(
      input: DataGridFilterInput
    ): getHedgeDCABacktestsResponse
    getGridBacktests(input: DataGridFilterInput): getGridBacktestsResponse
    getLeverageBracketsByUUID(
      input: getLeverageInput
    ): getLeverageBracketResponse
    getBacktestByShareId(
      input: getBacktestsInput!
    ): getBacktestByShareIdResponse
    getComboBacktestByShareId(
      input: getBacktestsInput!
    ): getComboBacktestByShareIdResponse
    getHedgeComboBacktestByShareId(
      input: getBacktestsInput!
    ): getHedgeComboBacktestByShareIdResponse
    getHedgeDCABacktestByShareId(
      input: getBacktestsInput!
    ): getHedgeDCABacktestByShareIdResponse
    getGridBacktestByShareId(
      input: getBacktestsInput!
    ): getGridBacktestByShareIdResponse
    getDCABotSettings(input: getBotSettingsInput!): getDCABotSettingsResponse
    getComboBotSettings(
      input: getBotSettingsInput!
    ): getComboBotSettingsResponse
    getHedgeComboBotSettings(
      input: getBotSettingsInput!
    ): getHedgeComboBotSettingsResponse
    getHedgeDCABotSettings(
      input: getBotSettingsInput!
    ): getHedgeComboBotSettingsResponse
    getGridBotSettings(input: getBotSettingsInput!): getGridBotSettingsResponse
    getBotEvents(input: getBotEventsInput!): getBotEventsResponse
    getAllOpenOrders(input: getAllOpenOrdersInput): getAllOpenOrdersResponse
    getAllOpenPositions(
      input: getAllOpenOrdersInput
    ): getAllOpenPositionsResponse
    getBotProfitChartData(
      input: getBotProfitChartDataInput!
    ): getBotProfitChartDataResponse
    compareBalances(input: compareBalancesInput!): compareBalancesResponse
  }
  type Mutation {
    moveDealToTerminal(
      input: moveDealToTerminalInput!
    ): moveDealToTerminalResponse
    restoreDeal(input: restoreDealInput!): moveDealToTerminalResponse
    moveGridToTerminal(
      input: moveGridToTerminalInput!
    ): moveGridToTerminalResponse
    requestServerSideBacktest(
      input: requestServerSideBacktestInput!
    ): requestOnboardingBacktestResponse
    addDealFunds(input: addDealFundsInput!): addFundsResponse
    reduceDealFunds(input: addDealFundsInput!): addFundsResponse
    cancelTerminalDealOrder(
      input: cancelTerminalDealOrderInput!
    ): cancelTerminalDealOrderResponse
    cancelPendingAddFundsDealOrder(
      input: cancelTerminalDealOrderInput!
    ): cancelTerminalDealOrderResponse
    createBot(input: createBotInput!): createBotResponse
    createDCABot(input: createDCABotInput!): createDCABotResponse
    createComboBot(input: createComboBotInput!): createComboBotResponse
    createHedgeComboBot(
      input: createHedgeComboBotInput!
    ): createHedgeComboBotResponse
    changeHedgeComboBot(
      input: changeHedgeComboBotInput!
    ): getHedgeComboBotResponse
    createHedgeDCABot(
      input: createHedgeComboBotInput!
    ): createHedgeComboBotResponse
    changeHedgeDCABot(
      input: changeHedgeComboBotInput!
    ): getHedgeComboBotResponse
    changeBotShare(input: changeBotShareInput!): changeBotShareResponse
    changeBot(input: changeBotInput!): getBotResponse
    changeDCABot(input: changeDCABotInput!): getDCABotResponse
    changeComboBot(input: changeComboBotInput!): getComboBotResponse
    changeDCADealSettings(
      input: dcaDealSettingsInput!
    ): updateDCADealSettingsResponse
    changeComboDealSettings(
      input: comboDealSettingsInput!
    ): updateComboDealSettingsResponse
    openDCADeal(input: openDCADeal!): openDCADealResponse
    openComboDeal(input: openDCADeal!): openDCADealResponse
    closeDCADeal(input: closeDCADeal!): openDCADealResponse
    closeComboDeal(input: closeDCADeal!): openDCADealResponse
    changeStatus(input: changeStatusInput!): getBotResponse
    deleteBotMessage(input: deleteBotMessageInput!): deleteBotMessageResponse
    deleteBot(input: deleteBotInput!): deleteBotResponse
    mergeDeals(input: mergeDealsInput!): mergeDealsResponse
    mergeComboDeals(input: mergeDealsInput!): mergeDealsResponse
    saveBacktest(input: backtestInput!): saveBacktestsResponse
    saveComboBacktest(input: comboBacktestInput!): saveBacktestsResponse
    saveHedgeComboBacktest(
      input: hedgeComboBacktestInput!
    ): saveBacktestsResponse
    saveHedgeDCABacktest(input: hedgeDCABacktestInput!): saveBacktestsResponse
    saveGridBacktest(input: gridBacktestInput!): saveBacktestsResponse
    setBacktestPermanentStatus(
      input: setBacktestPermanentStatusInput!
    ): saveBacktestsResponse
    setComboBacktestPermanentStatus(
      input: setBacktestPermanentStatusInput!
    ): saveBacktestsResponse
    setHedgeComboBacktestPermanentStatus(
      input: setBacktestPermanentStatusInput!
    ): saveBacktestsResponse
    setHedgeDCABacktestPermanentStatus(
      input: setBacktestPermanentStatusInput!
    ): saveBacktestsResponse
    setBacktestTextFields(
      input: setBacktestTextFieldsInput!
    ): saveBacktestsResponse
    setDealNote(input: setDealNoteInput!): saveBacktestsResponse
    setGridBacktestPermanentStatus(
      input: setBacktestPermanentStatusInput!
    ): saveBacktestsResponse
    deleteBacktests(input: deleteBacktestsInput!): saveBacktestsResponse
    deleteComboBacktests(input: deleteBacktestsInput!): saveBacktestsResponse
    deleteHedgeComboBacktests(
      input: deleteBacktestsInput!
    ): saveBacktestsResponse
    deleteHedgeDCABacktests(input: deleteBacktestsInput!): saveBacktestsResponse
    deleteGridBacktests(input: deleteBacktestsInput!): saveBacktestsResponse
    shareBacktest(input: shareBacktestInput): shareBacktestResponse
    shareComboBacktest(input: shareBacktestInput): shareBacktestResponse
    shareHedgeComboBacktest(input: shareBacktestInput): shareBacktestResponse
    shareHedgeDCABacktest(input: shareBacktestInput): shareBacktestResponse
    shareGridBacktest(input: shareBacktestInput): shareBacktestResponse
    setArchive(input: setArchiveInput!): setArchiveResponse
    closeOrderOnExchange(
      input: closeOrderOnExchangeInput!
    ): closeOrderOnExchangeResponse
    importExchangeOrder(input: importExchangeOrderInput!): createDCABotResponse
    closePositionOnExchange(
      input: closePositionOnExchangeInput!
    ): closePositionOnExchangeResponse
    resetShowError(input: resetShowErrorInput!): resetShowErrorResponse
    manageBalanceDiff(input: manageBalanceDiffInput!): manageBalanceDiffResponse
  }
  input shareBacktestInput {
    _id: String
  }
  type shareBacktestResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input changeBotShareInput {
    botId: String!
    type: botTypeEnum!
    share: Boolean!
  }
  type botShare {
    share: Boolean
    shareId: String
  }
  type changeBotShareResponse implements BasicResponse {
    status: Status
    reason: String
    data: botShare
  }
  input getComboBotDealsByIdInput {
    botId: String!
    id: [String!]!
  }
  input getMessageBotInput {
    unreadOnly: Boolean
    page: Int
    pageSize: Int
    search: String
  }
  input moveDealToTerminalInput {
    botId: ID!
    dealId: ID!
    combo: Boolean!
  }
  input restoreDealInput {
    botId: ID!
    dealId: ID!
  }
  input moveGridToTerminalInput {
    gridId: ID!
  }
  type moveDealToTerminalResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type moveGridToTerminalResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input searchByBotNameInput {
    search: String
    type: botTypeEnum!
  }
  type botSearchData {
    name: String
    id: String
  }
  type searchByBotNameResponse implements BasicResponse {
    status: Status
    reason: String
    data: [botSearchData]
  }
  type manageBalanceDiffResponse implements BasicResponse {
    status: Status
    reason: String
  }
  input manageBalanceDiffInput {
    botId: String!
    dealId: String!
    qty: Float!
    side: String!
  }
  input compareBalancesInput {
    botId: String!
    dealId: String!
  }
  type compareBalancesData {
    currentBase: Float
    currentQuote: Float
    realBase: Float
    realQuote: Float
    filledBase: Float
    filledQuote: Float
    feeBase: Float
    feeQuote: Float
    suggestedAction: String
    diffBase: Float
    diffQuote: Float
  }
  type compareBalancesResponse implements BasicResponse {
    status: Status
    reason: String
    data: compareBalancesData
  }
  input dealDashboardStatsInput {
    type: botTypeEnum!
    terminal: Boolean
  }
  type dealDashboardStatsResult {
    normal: Float
    inProfit: Float
    eighty: Float
    max: Float
    unrealizedProfit: Float
  }
  type dealDashboardStats {
    result: [dealDashboardStatsResult]
  }
  type dealDashboardStatsResponse implements BasicResponse {
    status: Status
    reason: String
    data: dealDashboardStats
  }
  input botDashboardStatsInput {
    type: botTypeEnum!
    terminal: Boolean
  }
  type botDashboardStatsResult {
    status: BotStatus
    count: Float
  }
  type botDashboardStats {
    result: [botDashboardStatsResult]
  }
  type botDashboardStatsResponse implements BasicResponse {
    status: Status
    reason: String
    data: botDashboardStats
  }
  input getBotProfitChartDataInput {
    type: botTypeEnum
    id: String
  }
  type profitChartData {
    value: Float
    time: Float
  }
  type getBotProfitChartDataResponse implements BasicResponse {
    status: Status
    reason: String
    data: [profitChartData]
  }
  input resetShowErrorInputData {
    type: botTypeEnum
    id: String
  }
  input resetShowErrorInput {
    data: [resetShowErrorInputData]
  }
  type resetShowErrorResponse implements BasicResponse {
    reason: String
    status: Status
  }
  input getServerSideBacktestRequestsInput {
    type: botTypeEnum
    page: Int
    pageSize: Int
    sortModel: [GridSortItem]
    filterModel: GridFilterModel
  }
  type serverSideBacktestSymbols {
    pair: String
    quoteAsset: String
    baseAsset: String
  }
  type ssbStatusHistory {
    status: String
    time: Float
  }
  type serverSideBacktestRequests {
    symbols: [serverSideBacktestSymbols]
    exchange: Exchange
    exchangeUUID: String
    userId: String
    status: String
    backtestId: String
    type: botTypeEnum
    created: Date
    _id: String
    statusHistory: [ssbStatusHistory]
    statusReason: String
    cost: Float
  }
  type getServerSideBacktestRequestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [serverSideBacktestRequests]
    total: Float
  }
  type requestOnboardingBacktestResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input ServerSideBacktestPayload {
    type: botTypeEnum
    data: BacktestDataInput
    config: inputBacktestConfig
  }
  input serverSideBacktestSymbolsInput {
    pair: String
    quoteAsset: String
    baseAsset: String
  }
  input requestServerSideBacktestInput {
    payload: ServerSideBacktestPayload
    symbols: [serverSideBacktestSymbolsInput]
  }
  input addDealFundsInput {
    dealId: String!
    botId: String!
    qty: String!
    useLimitPrice: Boolean!
    limitPrice: String
    asset: String!
    type: String
  }
  input cancelTerminalDealOrderInput {
    dealId: String!
    botId: String!
    orderId: String!
  }
  type addFundsResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type cancelTerminalDealOrderResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input getPresetByIdInput {
    id: String!
  }
  input importExchangeOrderInput {
    orderId: String!
    exchangeUUID: String!
    symbol: String!
    newBotSettings: importBotSettings
  }
  input importBotSettings {
    symbol: String!
    baseAsset: String!
    quoteAsset: String!
    price: String!
    quantity: String!
    side: String!
  }
  input getLeverageInput {
    uuid: String!
  }
  input getAllOpenOrdersInput {
    exchangeUUID: String!
  }
  input closeOrderOnExchangeInput {
    symbol: String!
    orderId: String!
    exchangeUUID: String!
  }
  input closePositionOnExchangeInput {
    positionId: String!
    exchangeUUID: String!
  }
  type leverageBracket {
    symbol: String
    leverage: Float
    step: Float
    min: Float
  }
  type minigridReponse implements BasicResponse {
    status: Status
    reason: String
    data: [minigrids]
    total: Int
  }
  type closeOrderOnExchangeResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type closePositionOnExchangeResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type getLeverageBracketResponse implements BasicResponse {
    status: Status
    reason: String
    data: [leverageBracket]
  }
  type getAllOpenOrdersResponse implements BasicResponse {
    status: Status
    reason: String
    data: [openOrder]
  }
  type getAllOpenPositionsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [openPosition]
  }
  type openPosition {
    symbol: String!
    created: Date!
    exchange: Exchange!
    exchangeUUID: String!
    exchangeName: String!
    leverage: String!
    side: String!
    price: String!
    quantity: String!
    baseAssetName: String
    quoteAssetName: String
    positionId: String!
    botId: String
    botName: String
    botType: String
    marginType: BotMarginTypeEnum
  }
  type openOrder {
    symbol: String!
    botId: String
    botName: String
    side: orderSide
    type: orderType
    created: Date
    exchange: Exchange!
    exchangeUUID: String!
    exchangeName: String!
    status: String!
    botType: String
    dealId: String
    price: String!
    quantity: String!
    quoteAssetName: String
    baseAssetName: String
    orderId: String!
    executedQty: String
    clientOrderId: String
    reduceFundsId: String
  }
  type dealStats {
    avgUsage: Float
    avgProfit: Float
    avgTradingTime: Float
    avgTimeInLoss: Float
    avgTimeInProfit: Float
    winRate: Float
  }
  type fullDeal {
    deals: [dcaDeal]
    page: Int
    total: Int
  }
  type fullComboDeal {
    deals: [comboDeal]
    page: Int
    total: Int
  }
  type botDealsResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullDeal
  }
  type botComboDealsResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullComboDeal
  }
  type dealStatsData {
    stats: dealStats
  }
  type botDealsStatsResponse implements BasicResponse {
    status: Status
    reason: String
    data: dealStatsData
  }
  input getBacktestsInput {
    shareId: String!
  }
  input getBotOrdersInput {
    id: String!
    shareId: String
    type: botTypeEnum!
    status: String!
    page: Int
    pageSize: Int
    sortModel: [GridSortItem]
    filterModel: GridFilterModel
  }
  input getDealOrdersInput {
    id: String!
    shareId: String
    dealId: String!
    all: Boolean
  }
  input getBotTransactionsInput {
    id: String!
    shareId: String
    page: Int!
  }
  input getBotDealsInput {
    id: String!
    shareId: String
    page: Int!
    status: String!
    pageSize: Int
    sortModel: [GridSortItem]
    filterModel: GridFilterModel
  }
  input getBotDealsStatsInput {
    id: String!
    shareId: String
  }
  type fullOrders {
    orders: [botOrder]
    page: Int
    total: Int
  }
  type botShare {
    share: Boolean
    shareId: String
  }
  type dealOrdersResponse implements BasicResponse {
    status: Status
    reason: String
    data: [botOrder]
  }
  type botOrdersResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullOrders
  }
  type fullTransactions {
    transactions: [botTransaction]
    page: Int
    total: Int
  }
  type botTransactionsResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullTransactions
  }
  type gridSettings {
    settings: botSettings
    exchange: String
    exchangeUUID: String
    baseAsset: String
    quoteAsset: String
    created: Date
    updated: Date
    vars: botVars
  }
  type getGridBotSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: gridSettings
  }
  type botEventCounts {
    recent: Float
    deals: Float
    alerts: Float
  }
  type getBotEventsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [botEvent]
    total: Float
    counts: botEventCounts
  }
  scalar StringOrAny
  type botEvent {
    botId: String!
    botType: botTypeEnum!
    userId: String!
    event: String!
    description: String
    type: String
    created: Date!
    _id: String
    metadata: StringOrAny
    deal: String
    symbol: String
  }
  type dcaSettings {
    settings: DCABotSettings
    exchange: String
    exchangeUUID: String
    baseAsset: [String]
    quoteAsset: [String]
    created: Date
    updated: Date
    vars: botVars
  }
  type comboSettings {
    settings: ComboBotSettings
    exchange: String
    exchangeUUID: String
    baseAsset: [String]
    quoteAsset: [String]
    created: Date
    updated: Date
    vars: botVars
  }
  type getDCABotSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: dcaSettings
  }
  type getComboBotSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: comboSettings
  }
  type getHedgeComboBotSettingsResponseData {
    long: comboSettings
    short: comboSettings
    sharedSettings: sharedSettings
    created: Date
    updated: Date
  }
  type getHedgeComboBotSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: getHedgeComboBotSettingsResponseData
  }
  input getBotSettingsInput {
    botId: String!
    shareId: String
  }
  input getBotEventsInput {
    botId: String!
    page: Float
    pageSize: Float
    sortModel: [GridSortItem]
    filterModel: GridFilterModel
    hedge: Boolean
    combo: Boolean
    category: String
  }
  type SplitTime {
    d: String
    h: String
    min: String
    s: String
  }
  input inputSplitTime {
    d: String
    h: String
    min: String
    s: String
  }
  input GridSortItem {
    field: String
    sort: String
  }
  input GridFilterItem {
    field: String
    operator: String
    columnField: String @deprecated(reason: "Use 'field' instead.")
    operatorValue: String @deprecated(reason: "Use 'operator' instead.")
    value: StringOrArrayOfStrings
    id: StringOrNumber
    fromInput: String
  }
  input GridFilterModel {
    items: [GridFilterItem]
    linkOperator: String
    quickFilterValues: [GridFilterItem]
    quickFilterLogicOperator: String
    logicOperator: String
  }
  input getDcaBotListInput {
    all: Boolean
    status: [BotStatus]
    dataGridInput: DataGridFilterInput
  }
  input getDcaDealListInput {
    botId: String
    exchange: String
    userId: String
    status: [DCADealStatusEnum]
    paperContext: Boolean
    terminal: Boolean
    dataGridInput: DataGridFilterInput
  }
  type financialBacktest {
    netProfitTotal: Float
    netProfitTotalUsd: Float
    grossProfit: Float
    grossProfitUsd: Float
    grossLoss: Float
    grossLossUsd: Float
    avgGrossProfit: Float
    avgGrossProfitUsd: Float
    avgGrossLoss: Float
    avgGrossLossUsd: Float
    avgNetProfit: Float
    avgNetProfitUsd: Float
    avgNetDaily: Float
    avgNetDailyUsd: Float
    unrealizedPnL: Float
    unrealizedPnLUsd: Float
    unrealizedPnLPerc: Float
    unrealizedUsage: Float
    maxDealProfit: Float
    maxDealLoss: Float
    maxDealProfitUsd: Float
    maxDealLossUsd: Float
    maxRunUp: Float
    maxRunUpUsd: Float
    maxDrawDown: Float
    maxDrawDownUsd: Float
    maxDrawDownEquityUsd: Float
    maxDrawDownEquityPerc: Float
    netProfitTotalPerc: Float
    grossProfitPerc: Float
    grossLossPerc: Float
    avgGrossProfitPerc: Float
    avgGrossLossPerc: Float
    avgNetProfitPerc: Float
    avgNetDailyPerc: Float
    annualizedReturn: FloatOrInfinity
    maxDealProfitPerc: Float
    maxDealLossPerc: Float
    maxRunUpPerc: Float
    maxDrawDownPerc: Float
    initialBalanceUsd: Float
    stDevWinningTrade: Float
    stDevLosingTrade: Float
    stDownDevLosingTrade: Float
  }
  type financialGridBacktest {
    freeProfitTotal: Float
    freeProfitTotalUsd: Float
    profitTotal: String
    profitTotalUsd: Float
    budgetUsd: Float
    avgNetDaily: String
    avgNetDailyUsd: Float
    avgTransactionProfit: String
    avgTransactionProfitUsd: Float
    initialBalances: String
    initialBalancesUsd: Float
    currentBalances: String
    currentBalancesUsd: Float
    valueChange: String
    valueChangeUsd: Float
    startPrice: String
    lastPrice: String
    breakevenPrice: Float
    initialBalancesByAsset: balanceInBacktest
    currentBalancesByAsset: balanceInBacktest
    profitTotalPerc: Float
    avgNetDailyPerc: Float
    annualizedReturn: FloatOrInfinity
    valueChangePerc: Float
    avgTransactionProfitPerc: Float
  }
  type balanceInBacktest {
    base: String
    quote: String
  }
  input balance {
    base: String
    quote: String
  }
  input financialGridBacktestInput {
    freeProfitTotal: Float
    freeProfitTotalUsd: Float
    profitTotal: String
    profitTotalUsd: Float
    budgetUsd: Float
    avgNetDaily: String
    avgNetDailyUsd: Float
    avgTransactionProfit: String
    avgTransactionProfitUsd: Float
    initialBalances: String
    initialBalancesUsd: Float
    currentBalances: String
    currentBalancesUsd: Float
    valueChange: String
    valueChangeUsd: Float
    startPrice: String
    lastPrice: String
    breakevenPrice: Float
    initialBalancesByAsset: balance
    currentBalancesByAsset: balance
    profitTotalPerc: Float
    avgNetDailyPerc: Float
    annualizedReturn: FloatOrInfinity
    valueChangePerc: Float
    avgTransactionProfitPerc: Float
  }
  input inputFinancialBacktest {
    netProfitTotal: Float
    netProfitTotalUsd: Float
    grossProfit: Float
    grossProfitUsd: Float
    grossLoss: Float
    grossLossUsd: Float
    avgGrossProfit: Float
    avgGrossProfitUsd: Float
    avgGrossLoss: Float
    avgGrossLossUsd: Float
    avgNetProfit: Float
    avgNetProfitUsd: Float
    avgNetDaily: Float
    avgNetDailyUsd: Float
    unrealizedPnL: Float
    unrealizedPnLUsd: Float
    unrealizedPnLPerc: Float
    maxDealProfit: Float
    maxDealLoss: Float
    maxDealProfitUsd: Float
    maxDealLossUsd: Float
    maxRunUp: Float
    maxRunUpUsd: Float
    maxDrawDown: Float
    maxDrawDownUsd: Float
    maxDrawDownEquityUsd: Float
    maxDrawDownEquityPerc: Float
    netProfitTotalPerc: Float
    grossProfitPerc: Float
    grossLossPerc: Float
    avgGrossProfitPerc: Float
    avgGrossLossPerc: Float
    avgNetProfitPerc: Float
    avgNetDailyPerc: Float
    annualizedReturn: FloatOrInfinity
    maxDealProfitPerc: Float
    maxDealLossPerc: Float
    maxRunUpPerc: Float
    maxDrawDownPerc: Float
    initialBalanceUsd: Float
    stDevWinningTrade: Float
    stDevLosingTrade: Float
    stDownDevLosingTrade: Float
    unrealizedUsage: Float
  }
  type durationBacktest {
    avgDealDuration: Float
    avgSplitDealDuration: SplitTime
    firstDataTime: Float
    lastDataTime: Float
    loadingDataTime: Float
    processingDataTime: Float
    botWorkingTime: SplitTime
    botWorkingTimeNumber: Float
    maxDealDuration: SplitTime
    maxDealDurationTime: Float
    periodName: String
    avgWinningTrade: Float
    maxWinningTrade: Float
    avgLosingTrade: Float
    maxLosingTrade: Float
  }
  type durationGridBacktest {
    firstDataTime: Float
    lastDataTime: Float
    loadingDataTime: Float
    processingDataTime: Float
    botWorkingTime: SplitTime
    botWorkingTimeNumber: Float
    periodName: String
  }
  input durationGridBacktestInput {
    firstDataTime: Float
    lastDataTime: Float
    loadingDataTime: Float
    processingDataTime: Float
    botWorkingTime: inputSplitTime
    botWorkingTimeNumber: Float
    periodName: String
  }
  input inputDurationBacktest {
    avgDealDuration: Float
    avgSplitDealDuration: inputSplitTime
    firstDataTime: Float
    lastDataTime: Float
    loadingDataTime: Float
    processingDataTime: Float
    botWorkingTime: inputSplitTime
    botWorkingTimeNumber: Float
    maxDealDuration: inputSplitTime
    maxDealDurationTime: Float
    periodName: String
    avgWinningTrade: Float
    maxWinningTrade: Float
    avgLosingTrade: Float
    maxLosingTrade: Float
  }
  input setBacktestPermanentStatusInput {
    id: String!
    savePermanent: Boolean!
  }
  input setBacktestTextFieldsInput {
    type: botTypeEnum!
    id: String!
    name: String
    note: String
  }
  input setDealNoteInput {
    type: botTypeEnum!
    id: String!
    note: String
  }
  type usageBacktest {
    maxTheoreticalUsage: Float
    maxRealUsage: Float
    avgRealUsage: Float
    maxTheoreticalUsageWithRate: Float
  }
  input inputUsageBacktest {
    maxTheoreticalUsage: Float
    maxRealUsage: Float
    avgRealUsage: Float
    maxTheoreticalUsageWithRate: Float
  }
  type numericalBacktest {
    all: Float
    profit: Float
    loss: Float
    open: Float
    closed: Float
    maxConsecutiveWins: Float
    maxConsecutiveLosses: Float
    maxDCATriggered: Float
    avgDCATriggered: Float
    dealsPerDay: Float
    coveredPriceDeviation: Float
    actualPriceDeviation: Float
    liquidationEvents: Float
    confidenceGrade: String
    dealsForConfidenceGrade: Float
    priceDeviation: Float
  }
  type numericalGridBacktest {
    all: Float
    transactionsPerDay: Float
    buy: Float
    sell: Float
  }
  input numericalGridBacktestInput {
    all: Float
    transactionsPerDay: Float
    buy: Float
    sell: Float
  }
  input inputNumericalBacktest {
    all: Float
    profit: Float
    loss: Float
    open: Float
    closed: Float
    maxConsecutiveWins: Float
    maxConsecutiveLosses: Float
    maxDCATriggered: Float
    avgDCATriggered: Float
    dealsPerDay: Float
    coveredPriceDeviation: Float
    actualPriceDeviation: Float
    liquidationEvents: Float
    confidenceGrade: String
    dealsForConfidenceGrade: Float
    priceDeviation: Float
  }
  type bnhRatio {
    value: Float
    valueUsd: Float
    perc: Float
  }
  input inputBnhRatio {
    value: Float
    valueUsd: Float
    perc: Float
  }
  type ratiosBacktest {
    profitFactor: FloatOrInfinity
    profitByPeriod: [Float]
    buyAndHold: bnhRatio
    periodRatio: Float
    sharpe: Float
    sortino: Float
    cwr: Float
  }
  type ratiosGridBacktest {
    profitByPeriod: [Float]
    buyAndHold: bnhRatio
    periodRatio: Float
    sharpe: Float
    sortino: Float
    cwr: Float
  }
  input ratiosGridBacktestInput {
    profitByPeriod: [Float]
    buyAndHold: inputBnhRatio
    periodRatio: Float
    sharpe: Float
    sortino: Float
    cwr: Float
  }
  input inputRatiosBacktest {
    profitFactor: FloatOrInfinity
    profitByPeriod: [Float]
    buyAndHold: inputBnhRatio
    periodRatio: Float
    sharpe: Float
    sortino: Float
    cwr: Float
  }
  type backtestConfig {
    userFee: String
    slippage: String
    firstDataTime: Float
    lastDataTime: Float
    RFR: String
    MAR: String
    usage: String
    pair: String
    multiIdependent: Boolean
    multiCombined: Boolean
  }
  type SymbolStatsDeals {
    profit: Float
    loss: Float
    open: Float
  }
  type SymbolStatsProfit {
    total: Float
    totalUsd: Float
    perc: Float
  }
  type SymbolStats {
    pair: String
    deals: SymbolStatsDeals
    netProfit: SymbolStatsProfit
    dailyReturn: SymbolStatsProfit
    profitAsset: String
    winRate: Float
    profitFactor: String
    maxDealDuration: SplitTime
    avgDealDuration: SplitTime
  }
  type backtest {
    serverSide: Boolean
    noData: Boolean
    maxLeverage: Float
    _id: String
    financial: financialBacktest
    duration: durationBacktest
    usage: usageBacktest
    numerical: numericalBacktest
    ratios: ratiosBacktest
    interval: String
    quoteRate: Float
    symbol: String
    baseAsset: String
    quoteAsset: String
    userId: String
    time: Float
    exchange: String
    exchangeUUID: String
    settings: DCABotSettings
    savePermanent: Boolean
    shareId: String
    value: Float
    author: String
    sent: Boolean
    additionalExchanges: [String]
    config: backtestConfig
    note: String
    multi: Boolean
    multiPairs: Float
    symbolStats: [SymbolStats]
    periodicStats: [PeriodicStats]
    messages: [String]
  }
  type PeriodicStats {
    period: String
    startTime: Float
    netResult: Float
    drawdown: Float
    runup: Float
    deals: SymbolStatsDeals
  }
  type comboBacktest {
    serverSide: Boolean
    noData: Boolean
    maxLeverage: Float
    _id: String
    financial: financialBacktest
    duration: durationBacktest
    usage: usageBacktest
    numerical: numericalBacktest
    ratios: ratiosBacktest
    interval: String
    quoteRate: Float
    symbol: String
    baseAsset: String
    quoteAsset: String
    userId: String
    time: Float
    exchange: String
    exchangeUUID: String
    settings: ComboBotSettings
    savePermanent: Boolean
    shareId: String
    value: Float
    author: String
    sent: Boolean
    additionalExchanges: [String]
    config: backtestConfig
    note: String
    multi: Boolean
    multiPairs: Float
    symbolStats: [SymbolStats]
    periodicStats: [PeriodicStats]
    messages: [String]
  }
  type hedgeComboBacktestHedgeResult {
    financial: financialBacktest
    duration: durationBacktest
    usage: usageBacktest
    numerical: numericalBacktest
    ratios: ratiosBacktest
  }
  type hedgeComboBacktestSideResult {
    noData: Boolean
    maxLeverage: Float
    financial: financialBacktest
    duration: durationBacktest
    usage: usageBacktest
    numerical: numericalBacktest
    ratios: ratiosBacktest
    interval: String
    quoteRate: Float
    precision: Float
    multi: Boolean
    multiPairs: Float
    symbolStats: [SymbolStats]
    periodicStats: [PeriodicStats]
    messages: [String]
  }
  type hedgeComboBacktestSideConfig {
    symbol: String
    baseAsset: String
    quoteAsset: String
    exchange: String
    exchangeUUID: String
    settings: ComboBotSettings
    duration: durationBacktest
  }
  type hedgeDCABacktestSideConfig {
    symbol: String
    baseAsset: String
    quoteAsset: String
    exchange: String
    exchangeUUID: String
    settings: DCABotSettings
    duration: durationBacktest
  }
  type hedgeComboBacktest {
    _id: String
    serverSide: Boolean
    hedgeResult: hedgeComboBacktestHedgeResult
    longResult: hedgeComboBacktestSideResult
    shortResult: hedgeComboBacktestSideResult
    long: hedgeComboBacktestSideConfig
    short: hedgeComboBacktestSideConfig
    userId: String
    time: Float
    savePermanent: Boolean
    config: backtestConfig
    archive: Boolean
    author: String
    sent: Boolean
    note: String
    shareId: String
  }
  type hedgeDCABacktest {
    _id: String
    serverSide: Boolean
    hedgeResult: hedgeComboBacktestHedgeResult
    longResult: hedgeComboBacktestSideResult
    shortResult: hedgeComboBacktestSideResult
    long: hedgeDCABacktestSideConfig
    short: hedgeDCABacktestSideConfig
    userId: String
    time: Float
    savePermanent: Boolean
    config: backtestConfig
    archive: Boolean
    author: String
    sent: Boolean
    note: String
    shareId: String
  }
  type gridBacktest {
    serverSide: Boolean
    noData: Boolean
    maxLeverage: Float
    _id: String
    financial: financialGridBacktest
    duration: durationGridBacktest
    numerical: numericalGridBacktest
    ratios: ratiosGridBacktest
    interval: String
    quoteRate: Float
    symbol: String
    baseAsset: String
    quoteAsset: String
    userId: String
    time: Float
    exchange: String
    exchangeUUID: String
    settings: botSettings
    savePermanent: Boolean
    shareId: String
    position: gridBacktestPosition
    value: Float
    author: String
    sent: Boolean
    firstUsdRate: Float
    lastUsdRate: Float
    additionalExchanges: [String]
    config: backtestConfig
    note: String
  }
  type gridBacktestPosition {
    count: Float
    qty: Float
    price: Float
    side: String
    pnl: gridBacktestPositinPnl
  }
  type gridBacktestPositinPnl {
    value: Float
    perc: Float
  }
  type getGridBacktestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [gridBacktest]
    total: Float
  }
  type getBacktestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [backtest]
    total: Float
  }
  type getComboBacktestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [comboBacktest]
    total: Float
  }
  type getHedgeComboBacktestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [hedgeComboBacktest]
    total: Float
  }
  type getHedgeDCABacktestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [hedgeDCABacktest]
    total: Float
  }
  type getBacktestByShareIdResponse implements BasicResponse {
    status: Status
    reason: String
    data: backtest
  }
  type getComboBacktestByShareIdResponse implements BasicResponse {
    status: Status
    reason: String
    data: comboBacktest
  }
  type getHedgeComboBacktestByShareIdResponse implements BasicResponse {
    status: Status
    reason: String
    data: hedgeComboBacktest
  }
  type getHedgeDCABacktestByShareIdResponse implements BasicResponse {
    status: Status
    reason: String
    data: hedgeDCABacktest
  }
  type getGridBacktestByShareIdResponse implements BasicResponse {
    status: Status
    reason: String
    data: gridBacktest
  }
  type saveBacktestsResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input gridBacktestInput {
    noData: Boolean
    maxLeverage: Float
    financial: financialGridBacktestInput
    duration: durationGridBacktestInput
    numerical: numericalGridBacktestInput
    ratios: ratiosGridBacktestInput
    interval: String
    quoteRate: Float
    symbol: String
    baseAsset: String
    quoteAsset: String
    userId: String
    time: Float
    exchange: String
    exchangeUUID: String
    settings: createBotInput
    savePermanent: Boolean
    position: inputGridBacktestPosition
    firstUsdRate: Float
    lastUsdRate: Float
    config: inputBacktestConfig
  }
  input inputGridBacktestPosition {
    count: Float
    qty: Float
    price: Float
    side: String
    pnl: inputGridBacktestPositinPnl
  }
  input inputGridBacktestPositinPnl {
    value: Float
    perc: Float
  }
  input inputBacktestConfig {
    userFee: String
    slippage: String
    firstDataTime: Float
    lastDataTime: Float
    RFR: String
    MAR: String
    usage: String
    pair: String
    multiIdependent: Boolean
    multiCombined: Boolean
    periodName: String
  }
  input SymbolStatsDealsInput {
    profit: Float
    loss: Float
    open: Float
  }
  input SymbolStatsProfitInput {
    total: Float
    totalUsd: Float
    perc: Float
  }
  input SymbolStatsInput {
    pair: String
    deals: SymbolStatsDealsInput
    netProfit: SymbolStatsProfitInput
    dailyReturn: SymbolStatsProfitInput
    profitAsset: String
    winRate: Float
    profitFactor: String
    maxDealDuration: inputSplitTime
    avgDealDuration: inputSplitTime
  }
  input backtestInput {
    noData: Boolean
    maxLeverage: Float
    financial: inputFinancialBacktest
    duration: inputDurationBacktest
    usage: inputUsageBacktest
    numerical: inputNumericalBacktest
    ratios: inputRatiosBacktest
    interval: String
    quoteRate: Float
    symbol: String
    baseAsset: String
    quoteAsset: String
    userId: String
    time: Float
    exchange: String
    exchangeUUID: String
    settings: createDCABotInput
    savePermanent: Boolean
    config: inputBacktestConfig
    multi: Boolean
    multiPairs: Float
    symbolStats: [SymbolStatsInput]
    periodicStats: [PeriodicStatsInput]
    messages: [String]
  }
  input PeriodicStatsInput {
    period: String
    startTime: Float
    netResult: Float
    drawdown: Float
    runup: Float
    deals: SymbolStatsDealsInput
  }
  input comboBacktestInput {
    noData: Boolean
    maxLeverage: Float
    financial: inputFinancialBacktest
    duration: inputDurationBacktest
    usage: inputUsageBacktest
    numerical: inputNumericalBacktest
    ratios: inputRatiosBacktest
    interval: String
    quoteRate: Float
    symbol: String
    baseAsset: String
    quoteAsset: String
    userId: String
    time: Float
    exchange: String
    exchangeUUID: String
    settings: createComboBotInput
    savePermanent: Boolean
    config: inputBacktestConfig
    multi: Boolean
    multiPairs: Float
    symbolStats: [SymbolStatsInput]
    periodicStats: [PeriodicStatsInput]
    messages: [String]
  }
  input hedgeComboBacktestInputHedgeResult {
    financial: inputFinancialBacktest
    duration: inputDurationBacktest
    usage: inputUsageBacktest
    numerical: inputNumericalBacktest
    ratios: inputRatiosBacktest
  }
  input hedgeComboBacktestInputSideResult {
    noData: Boolean
    maxLeverage: Float
    financial: inputFinancialBacktest
    duration: inputDurationBacktest
    usage: inputUsageBacktest
    numerical: inputNumericalBacktest
    ratios: inputRatiosBacktest
    interval: String
    quoteRate: Float
    precision: Float
    multi: Boolean
    multiPairs: Float
    symbolStats: [SymbolStatsInput]
    periodicStats: [PeriodicStatsInput]
    messages: [String]
  }
  input hedgeComboBacktestInputSideConfig {
    symbol: String
    baseAsset: String
    quoteAsset: String
    exchange: String
    exchangeUUID: String
    settings: createComboBotInput
    duration: inputDurationBacktest
  }
  input hedgeDCABacktestInputSideConfig {
    symbol: String
    baseAsset: String
    quoteAsset: String
    exchange: String
    exchangeUUID: String
    settings: createDCABotInput
    duration: inputDurationBacktest
  }
  input hedgeComboBacktestInput {
    hedgeResult: hedgeComboBacktestInputHedgeResult
    longResult: hedgeComboBacktestInputSideResult
    shortResult: hedgeComboBacktestInputSideResult
    long: hedgeComboBacktestInputSideConfig
    short: hedgeComboBacktestInputSideConfig
    userId: String
    time: Float
    savePermanent: Boolean
    config: inputBacktestConfig
    archive: Boolean
    author: String
    sent: Boolean
    note: String
    shareId: String
  }
  input hedgeDCABacktestInput {
    hedgeResult: hedgeComboBacktestInputHedgeResult
    longResult: hedgeComboBacktestInputSideResult
    shortResult: hedgeComboBacktestInputSideResult
    long: hedgeDCABacktestInputSideConfig
    short: hedgeDCABacktestInputSideConfig
    userId: String
    time: Float
    savePermanent: Boolean
    config: inputBacktestConfig
    archive: Boolean
    author: String
    sent: Boolean
    note: String
    shareId: String
  }
  input deleteBacktestsInput {
    ids: [String]
  }
  type messageData {
    _id: String
    userId: String!
    botId: String!
    botName: String
    botType: String
    message: String!
    time: Float
    type: String
    paperContext: Boolean
    terminal: Boolean
    symbol: String
    exchange: String
  }
  type botMessageList {
    result: [messageData]
  }
  type botMessageGetResponse implements BasicResponse {
    status: Status
    reason: String
    data: botMessageList
    total: Float
  }
  type quantRulesCooldown {
    exchangeUUID: String
    exchange: String
    symbol: String
    scope: String
    level: Int
    until: String
    violationCount24h: Int
  }
  type quantRulesStatusResponse implements BasicResponse {
    status: Status
    reason: String
    data: [quantRulesCooldown]
  }
  type restartResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  enum BotStatus {
    closed
    open
    range
    error
    archive
    monitoring
  }
  enum Prioritize {
    level
    gridStep
  }
  enum Exchange {
    binance
    kucoin
    ftx
    bybit
    binanceUS
    ftxUS
    paperBinance
    paperFtx
    paperKucoin
    paperBybit
    binanceUsdm
    binanceCoinm
    paperBinanceUsdm
    paperBinanceCoinm
    bybitInverse
    bybitLinear
    paperBybitInverse
    paperBybitLinear
    okx
    okxLinear
    okxInverse
    paperOkx
    paperOkxLinear
    paperOkxInverse
    coinbase
    paperCoinbase
    kucoinLinear
    kucoinInverse
    paperKucoinLinear
    paperKucoinInverse
    bitget
    paperBitget
    bitgetUsdm
    paperBitgetUsdm
    bitgetCoinm
    paperBitgetCoinm
    mexc
    paperMexc
    hyperliquid
    paperHyperliquid
    hyperliquidLinear
    paperHyperliquidLinear
    kraken
    paperKraken
    krakenUsdm
    paperKrakenUsdm
    krakenCoinm
    paperKrakenCoinm
  }
  enum CurrencyEnum {
    quote
    base
  }
  enum TpSlConditionEnum {
    valueChanged
    priceReached
  }
  enum TpSlActionEnum {
    stop
    stopAndSell
  }
  input openDCADeal {
    botId: String!
    symbol: String
  }
  input resetDealSettingsInput {
    botId: String!
    dealId: String!
  }
  enum CloseDCATypeEnum {
    leave
    cancel
    closeByLimit
    closeByMarket
  }
  input closeDCADeal {
    botId: String!
    dealId: String!
    type: CloseDCATypeEnum
  }
  type botSettings {
    pair: String
    topPrice: Float
    lowPrice: Float
    levels: Int
    gridStep: Float
    budget: Float
    ordersInAdvance: Float
    useOrderInAdvance: Boolean
    prioritize: Prioritize
    profitCurrency: CurrencyEnum
    orderFixedIn: CurrencyEnum
    sellDisplacement: Float
    name: String
    gridType: GridTypeEnum
    tpSl: Boolean
    tpSlCondition: TpSlConditionEnum
    tpSlAction: TpSlActionEnum
    sl: Boolean
    slCondition: TpSlConditionEnum
    slAction: TpSlActionEnum
    tpPerc: Float
    slPerc: Float
    tpTopPrice: Float
    slLowPrice: Float
    updatedBudget: Boolean
    useStartPrice: Boolean
    startPrice: String
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    newProfit: Boolean
    newBalance: Boolean
    strategy: StrategyEnum
    futuresStrategy: FuturesStrategyEnum
    slLimit: Boolean
    tpSlLimit: Boolean
    feeOrder: Boolean
    skipBalanceCheck: Boolean
  }
  type botListResponse implements BasicResponse {
    status: Status
    reason: String
    data: [fullBot]
    total: Float
  }
  type resetDealSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type dcaBotListResponse implements BasicResponse {
    status: Status
    reason: String
    data: [fullDCABot]
    total: Float
  }
  type hedgeComboBotListResponse implements BasicResponse {
    status: Status
    reason: String
    data: [fullHedgeComboBot]
    total: Float
  }
  type comboBotListResponse implements BasicResponse {
    status: Status
    reason: String
    data: [fullComboBot]
    total: Float
  }
  type openDCADealResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input getBotInput {
    id: String!
    shareId: String
  }
  input getDCADealsInput {
    terminal: Boolean
  }
  input setArchiveInput {
    botIds: [String!]!
    archive: Boolean!
    type: botTypeEnum!
  }
  input setArchiveMultiPairInput {
    botIds: [String!]!
    archive: Boolean!
  }
  type archiveResponse {
    _id: String
    status: BotStatus
  }
  type setArchiveResponse implements BasicResponse {
    status: Status
    reason: String
    data: [archiveResponse]
  }
  type orderFill {
    tradeId: Int
    price: String
    qty: String
    commission: String
    commissionAsset: String
  }
  enum orderSide {
    BUY
    SELL
  }
  enum orderStatus {
    CANCELED
    EXPIRED
    FILLED
    NEW
    PARTIALLY_FILLED
    PENDING_CANCEL
    REJECTED
  }
  enum orderTime {
    GTC
    IOC
    FOK
  }
  enum orderType {
    LIMIT
    LIMIT_MAKER
    MARKET
    STOP
    STOP_MARKET
    STOP_LOSS_LIMIT
    TAKE_PROFIT_LIMIT
    TAKE_PROFIT_MARKET
    TRAILING_STOP_MARKET
  }
  enum typeOrder {
    regular
    swap
    dealTP
    dealStart
    dealRegular
    stop
    stab
    dealGrid
    split
    fee
    liquidation
    rebalance
  }
  enum InitialPriceFromEnum {
    start
    swap
    user
  }
  type botOrder {
    _id: String
    clientOrderId: String
    reduceFundsId: String
    cummulativeQuoteQty: String
    executedQty: String
    fills: [orderFill]
    icebergQty: String
    isIsolated: Boolean
    isWorking: Boolean
    orderId: Float
    orderListId: Int
    origQty: String
    price: String
    side: orderSide
    status: orderStatus
    stopPrice: String
    symbol: String
    baseAsset: String
    quoteAsset: String
    time: Float
    timeInForce: orderTime
    transactTime: Float
    type: orderType
    updateTime: Float
    created: Date
    updated: Date
    exchange: Exchange
    exchangeUUID: String
    botId: String
    userId: String
    typeOrder: typeOrder
    dealId: String
    tpSlTarget: String
    positionSide: String
    reduceOnly: Boolean
    closePosition: Boolean
    cumQuote: String
    cumBase: String
    cumQty: String
    avgPrice: String
    botName: String
    botType: botTypeEnum
    terminal: Boolean
    liquidation: Boolean
    sl: Boolean
    acBefore: Float
    acAfter: Float
  }
  type multiPairBotOrders {
    key: String
    value: [botOrder]
  }
  type botTransaction {
    _id: String
    updateTime: Float
    side: orderSide
    amountBaseBuy: Float
    amountQuoteBuy: Float
    amountBaseSell: Float
    amountQuoteSell: Float
    priceBuy: Float
    priceSell: Float
    idBuy: String
    idSell: String
    feeBase: Float
    feeQuote: Float
    profitBase: Float
    profitQuote: Float
    botId: String
    userId: String
    symbol: String
    baseAsset: String
    quoteAsset: String
    profitCurrency: String
    profitUsdt: Float
    cummulativeProfitBase: Float
    cummulativeProfitQuote: Float
    cummulativeProfitUsdt: Float
  }
  type botWorkingShift {
    start: Date
    end: Date
  }
  type Level {
    buy: Int
    sell: Int
  }
  type Levels {
    active: Level
    all: Level
  }
  type botProgress {
    stage: Int
    total: Int
    text: String
    isAllowedToCancel: Boolean
  }
  type botVars {
    list: [String]
    paths: [botVarsPath]
  }
  type botVarsPath {
    path: String
    variable: String
  }
  type liveStats {
    currentCost: Float
    maxCost: Float
    relativeCost: Float
    relativeCostString: String
    totalProfit: Float
    relativeProfit: Float
    value: Float
    relativeValue: Float
    avgDaily: Float
    avgDailyRelative: Float
    annualizedReturn: FloatOrInfinity
    tradingTimeString: String
    tradingTimeNumber: Float
    dealsTotal: Float
  }
  type GridLiveStats {
    budget: Float
    value: Float
    valueChange: Float
    valueChangePerc: Float
    avgDaily: Float
    avgDailyPerc: Float
    annualizedReturn: FloatOrInfinity
    freePorfit: Float
    freeProfitUsd: Float
    totalProfit: Float
    totalProfitUsd: Float
    tradingTime: Float
    tradingTimeString: String
  }
  type fullBot {
    _id: String
    userId: String
    status: BotStatus
    statusReason: String
    coldArchived: Boolean
    showErrorWarning: String
    settings: botSettings
    exchange: Exchange
    exchangeUUID: String
    created: Date
    updated: Date
    initialPrice: Float
    initialPriceStart: Float
    initialPriceFrom: InitialPriceFromEnum
    initialPriceStartFrom: InitialPriceFromEnum
    workingShift: [botWorkingShift]
    workingTimeNumber: Float
    unrealizedProfit: Float
    assets: botAssets
    initialBalances: botAsset
    currentBalances: botAsset
    levels: Levels
    usdRate: Float
    lastUsdRate: Float
    lastPrice: Float
    feeBalance: Float
    newBalance: Boolean
    transactionsCount: Level
    profit: Profit
    funding: Funding
    profitByAssets: [ProfitByAssets]
    symbol: Symbol
    profitToday: ProfitToday
    public: Boolean
    avgPrice: Float
    uuid: String
    progress: botProgress
    share: Boolean
    shareId: String
    workingTimeTotal: Float
    position: BotPosition
    exchangeUnassigned: Boolean
    vars: botVars
    stats: profitLossStats
    lastPositionChange: Float
    notEnoughBalance: botNotEnoughBalance
    cost: Float
    liveStats: GridLiveStats
  }
  type botNotEnoughBalance {
    thresholdPassed: Boolean
  }
  type BotPosition {
    side: String
    qty: Float
    price: Float
  }
  type indicatorGroupsType {
    id: String
    logic: String
    action: String
    section: String
  }
  type indicatorSettingsType {
    indicatorLength: Int
    indicatorValue: String
    indicatorCondition: String
    groupId: String
    indicatorInterval: String
    type: IndicatorsEnum
    uuid: String
    signal: String
    condition: String
    checkLevel: Int
    maType: String
    maCrossingValue: String
    maCrossingLength: Int
    maCrossingInterval: String
    maUUID: String
    bbCrossingValue: String
    stochSmoothK: Int
    stochSmoothD: Int
    stochUpper: String
    stochLower: String
    stochRSI: Int
    valueInsteadof: Float
    rsiValue: String
    rsiValue2: String
    srCrossingValue: String
    leftBars: Int
    rightBars: Int
    basePeriods: Int
    pumpPeriods: Int
    pump: Float
    baseCrack: Float
    indicatorAction: String
    section: String
    psarStart: Float
    psarInc: Float
    psarMax: Float
    stochRange: String
    minPercFromLast: String
    orderSize: String
    keepConditionBars: String
    voShort: Float
    voLong: Float
    uoFast: Float
    uoMiddle: Float
    uoSlow: Float
    momSource: String
    bbwpLookback: Float
    ecdTrigger: String
    xOscillator1: String
    xOscillator2: String
    xOscillator2length: Float
    xOscillator2Interval: String
    xOscillator2voLong: Float
    xOscillator2voShort: Float
    xoUUID: String
    percentile: Boolean
    percentileLookback: Float
    percentilePercentage: Float
    mar1length: Float
    mar1type: String
    mar2length: Float
    mar2type: String
    bbwMult: Float
    bbwMa: String
    bbwMaLength: Float
    macdFast: Float
    macdSlow: Float
    macdMaSource: String
    macdMaSignal: String
    divOscillators: [String]
    divType: String
    divMinCount: Float
    trendFilter: Boolean
    trendFilterLookback: Float
    trendFilterType: String
    trendFilterValue: Float
    factor: Float
    atrLength: Float
    stCondition: String
    pcUp: String
    pcDown: String
    pcCondition: String
    pcValue: String
    ppHighLeft: Float
    ppHighRight: Float
    ppLowLeft: Float
    ppLowRight: Float
    ppMult: Float
    ppValue: String
    ppType: String
    riskAtrMult: String
    dynamicArFactor: String
    athLookback: Float
    kcMa: String
    kcRange: String
    kcRangeLength: Float
    obfvgValue: String
    obfvgRef: String
    unpnlValue: Float
    unpnlCondition: String
    dcValue: String
    sessionDays: [Int]
    sessionRule: String
    lwMaxDuration: String
    lwThreshold: StringOrNumber
    lwValue: StringOrNumber
    lwCondition: String
  }
  enum MAEnum {
    sma
    ema
    wma
    price
    dema
    tema
    vwma
    hma
    rma
  }
  enum OrderSizeTypeEnum {
    base
    quote
    percTotal
    percFree
    usd
  }
  enum DCAType {
    terminal
    regular
  }
  type multiTP {
    target: String
    amount: String
    uuid: String
    fixed: String
  }
  input inputMultiTP {
    target: String
    amount: String
    uuid: String
    fixed: String
  }
  type DCABotSettings {
    pair: [String]
    name: String
    strategy: StrategyEnum
    profitCurrency: CurrencyEnum
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    skipBalanceCheck: Boolean
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    maxDealsPerHigherTimeframe: String
    useMaxDealsPerHigherTimeframe: Boolean
    remainderFullAmount: Boolean
    autoRebalancing: Boolean
    adaptiveClose: Boolean
    useStaticPriceFilter: Boolean
    useCooldown: Boolean
    useVolumeFilterAll: Boolean
    useDynamicPriceFilter: Boolean
    dynamicPriceFilterDeviation: String
    dynamicPriceFilterOverValue: String
    dynamicPriceFilterUnderValue: String
    dynamicPriceFilterPriceType: String
    useNoOverlapDeals: Boolean
    dynamicPriceFilterDirection: String
    useRiskReward: Boolean
    rrSlType: String
    rrSlFixedValue: String
    riskSlType: String
    riskSlAmountPerc: String
    riskSlAmountValue: String
    riskUseTpRatio: Boolean
    riskTpRatio: String
    riskMinPositionSize: String
    scaleDcaType: String
    startDealLogic: String
    stopDealLogic: String
    stopDealSlLogic: String
    stopBotLogic: String
    useRiskReduction: Boolean
    riskReductionValue: String
    useReinvest: Boolean
    reinvestValue: String
    startBotPriceCondition: String
    startBotPriceValue: String
    stopBotPriceCondition: String
    stopBotPriceValue: String
    startBotLogic: String
    botActualStart: BotStartTypeEnum
    riskMaxPositionSize: String
    dynamicArLockValue: Boolean
    riskMaxSl: String
    riskMinSl: String
    dcaCustom: [dcaCustomType]
    baseOrderSize: String
    baseOrderPrice: String
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum
    startCondition: StartConditionEnum
    tpPerc: String
    orderFixedIn: CurrencyEnum
    orderSize: String
    step: String
    ordersCount: Int
    activeOrdersCount: Int
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    useTp: Boolean
    useSl: Boolean
    slPerc: String
    useSmartOrders: Boolean
    minOpenDeal: String
    maxOpenDeal: String
    useDca: Boolean
    hodlAt: String
    hodlHourly: Boolean
    hodlDay: String
    hodlNextBuy: Float
    maxNumberOfOpenDeals: String
    indicators: [indicatorSettingsType]
    indicatorGroups: [indicatorGroupsType]
    orderSizeType: OrderSizeTypeEnum
    limitTimeout: String
    useLimitTimeout: Boolean
    notUseLimitReposition: Boolean
    type: DCAType
    cooldownAfterDealStart: Boolean
    cooldownAfterDealStartUnits: CooldownUnits
    cooldownAfterDealStartInterval: Int
    cooldownAfterDealStop: Boolean
    cooldownAfterDealStopUnits: CooldownUnits
    cooldownAfterDealStopInterval: Int
    cooldownAfterDealStartOption: String
    cooldownAfterDealStopOption: String
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    trailingSl: Boolean
    trailingTp: Boolean
    trailingTpPerc: String
    useCloseAfterX: Boolean
    useCloseAfterXwin: Boolean
    closeAfterXwin: String
    useCloseAfterXloss: Boolean
    closeAfterXloss: String
    useCloseAfterXprofit: Boolean
    closeAfterXprofitValue: String
    closeAfterXprofitCond: String
    closeAfterX: String
    useCloseAfterXopen: Boolean
    closeAfterXopen: String
    useMulti: Boolean
    maxDealsPerPair: String
    ignoreStartDeals: Boolean
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    botStart: BotStartTypeEnum
    useBotController: Boolean
    stopType: CloseDCATypeEnum
    stopStatus: BotStatus
    dealCloseCondition: CloseConditionEnum
    dealCloseConditionSL: CloseConditionEnum
    useMinTP: Boolean
    minTp: String
    closeDealType: CloseDCATypeEnum
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    terminalDealType: TerminalDealTypeEnum
    useMultiTp: Boolean
    multiTp: [multiTP]
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [multiTP]
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    gridLevel: String
    feeOrder: Boolean
    useVolumeFilter: Boolean
    volumeTop: String
    volumeValue: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    useRelativeVolumeFilter: Boolean
    relativeVolumeTop: String
    relativeVolumeValue: String
    useSeparateMaxDealsOverAndUnder: Boolean
    maxDealsOver: String
    maxDealsUnder: String
    useSeparateMaxDealsOverAndUnderPerSymbol: Boolean
    maxDealsOverPerSymbol: String
    maxDealsUnderPerSymbol: String
  }
  type ComboBotSettings {
    pair: [String]
    name: String
    strategy: StrategyEnum
    profitCurrency: CurrencyEnum
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    skipBalanceCheck: Boolean
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    maxDealsPerHigherTimeframe: String
    useMaxDealsPerHigherTimeframe: Boolean
    remainderFullAmount: Boolean
    autoRebalancing: Boolean
    adaptiveClose: Boolean
    useStaticPriceFilter: Boolean
    useCooldown: Boolean
    useVolumeFilterAll: Boolean
    useDynamicPriceFilter: Boolean
    dynamicPriceFilterDeviation: String
    dynamicPriceFilterOverValue: String
    dynamicPriceFilterUnderValue: String
    dynamicPriceFilterPriceType: String
    useNoOverlapDeals: Boolean
    dynamicPriceFilterDirection: String
    useRiskReward: Boolean
    rrSlType: String
    rrSlFixedValue: String
    riskSlType: String
    riskSlAmountPerc: String
    riskSlAmountValue: String
    riskUseTpRatio: Boolean
    riskTpRatio: String
    riskMinPositionSize: String
    scaleDcaType: String
    startDealLogic: String
    stopDealLogic: String
    stopDealSlLogic: String
    stopBotLogic: String
    useRiskReduction: Boolean
    riskReductionValue: String
    useReinvest: Boolean
    reinvestValue: String
    startBotPriceCondition: String
    startBotPriceValue: String
    stopBotPriceCondition: String
    stopBotPriceValue: String
    startBotLogic: String
    botActualStart: BotStartTypeEnum
    riskMaxPositionSize: String
    dynamicArLockValue: Boolean
    riskMaxSl: String
    riskMinSl: String
    dcaCustom: [dcaCustomType]
    baseOrderSize: String
    baseOrderPrice: String
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum
    startCondition: StartConditionEnum
    tpPerc: String
    orderFixedIn: CurrencyEnum
    orderSize: String
    step: String
    ordersCount: Int
    activeOrdersCount: Int
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    useTp: Boolean
    useSl: Boolean
    slPerc: String
    useSmartOrders: Boolean
    minOpenDeal: String
    maxOpenDeal: String
    useDca: Boolean
    hodlAt: String
    hodlHourly: Boolean
    hodlDay: String
    hodlNextBuy: Float
    maxNumberOfOpenDeals: String
    indicators: [indicatorSettingsType]
    indicatorGroups: [indicatorGroupsType]
    orderSizeType: OrderSizeTypeEnum
    limitTimeout: String
    useLimitTimeout: Boolean
    notUseLimitReposition: Boolean
    type: DCAType
    cooldownAfterDealStart: Boolean
    cooldownAfterDealStartUnits: CooldownUnits
    cooldownAfterDealStartInterval: Int
    cooldownAfterDealStop: Boolean
    cooldownAfterDealStopUnits: CooldownUnits
    cooldownAfterDealStopInterval: Int
    cooldownAfterDealStartOption: String
    cooldownAfterDealStopOption: String
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    trailingSl: Boolean
    trailingTp: Boolean
    trailingTpPerc: String
    useCloseAfterX: Boolean
    useCloseAfterXwin: Boolean
    closeAfterXwin: String
    useCloseAfterXloss: Boolean
    closeAfterXloss: String
    useCloseAfterXprofit: Boolean
    closeAfterXprofitValue: String
    closeAfterXprofitCond: String
    closeAfterX: String
    useCloseAfterXopen: Boolean
    closeAfterXopen: String
    useMulti: Boolean
    maxDealsPerPair: String
    ignoreStartDeals: Boolean
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    botStart: BotStartTypeEnum
    useBotController: Boolean
    stopType: CloseDCATypeEnum
    stopStatus: BotStatus
    dealCloseCondition: CloseConditionEnum
    dealCloseConditionSL: CloseConditionEnum
    useMinTP: Boolean
    minTp: String
    closeDealType: CloseDCATypeEnum
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    terminalDealType: TerminalDealTypeEnum
    useMultiTp: Boolean
    multiTp: [multiTP]
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [multiTP]
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    gridLevel: String
    feeOrder: Boolean
    useVolumeFilter: Boolean
    volumeTop: String
    volumeValue: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    useRelativeVolumeFilter: Boolean
    relativeVolumeTop: String
    relativeVolumeValue: String
    useSeparateMaxDealsOverAndUnder: Boolean
    maxDealsOver: String
    maxDealsUnder: String
    useSeparateMaxDealsOverAndUnderPerSymbol: Boolean
    maxDealsOverPerSymbol: String
    maxDealsUnderPerSymbol: String
  }
  enum CloseConditionEnum {
    tp
    techInd
    manual
    webhook
    dynamicAr
  }
  enum BotStartTypeEnum {
    manual
    webhook
    indicators
    price
  }
  enum CooldownUnits {
    seconds
    minutes
    hours
    days
  }
  type Usage {
    current: botAsset
    max: botAsset
    currentUsd: Float
    maxUsd: Float
    relative: Float
  }
  type dealsInBot {
    active: Int
    all: Int
  }
  type multiAsset {
    key: String
    value: FloatOrInfinity
  }
  type botMultiAsset {
    base: [multiAsset]
    quote: [multiAsset]
  }
  type usedBotAssets {
    used: botMultiAsset
    required: botMultiAsset
  }
  type usdAssetNumber {
    usd: Float
    asset: Float
  }
  type botStatsSeries {
    count: Float
    value: usdAssetNumber
    minValue: usdAssetNumber
    maxValue: usdAssetNumber
    perc: Float
  }
  type botStatsNumericalProfit {
    grossProfit: usdAssetNumber
    grossProfitPerc: Float
    maxDealProfit: usdAssetNumber
    maxDealProfitPerc: Float
    avgDealProfit: usdAssetNumber
    avgDealProfitPerc: Float
    maxRunUp: usdAssetNumber
    maxRunUpPerc: Float
    maxConsecutiveWins: Float
    standardDeviationOfPositiveReturns: Float
    series: botStatsSeries
  }
  type botStatsNumericalLossSeriesEquity {
    value: Float
    min: Float
    max: Float
    perc: Float
  }
  type botStatsNumericalLoss {
    grossLoss: usdAssetNumber
    grossLossPerc: Float
    maxDealLoss: usdAssetNumber
    maxDealLossPerc: Float
    avgDealLoss: usdAssetNumber
    avgDealLossPerc: Float
    maxDrawdown: usdAssetNumber
    maxDrawdownPerc: Float
    maxEquityDrawdown: usdAssetNumber
    maxEquityDrawdownPerc: Float
    maxConsecutiveLosses: Float
    standardDeviationOfNegativeReturns: Float
    standardDeviationOfDownside: Float
    series: botStatsSeries
    seriesEquity: botStatsNumericalLossSeriesEquity
  }
  type BotStatsBestDay {
    time: Float
    value: Float
    percentage: Float
  }
  type botStatsNumericalGeneral {
    bestDay: BotStatsBestDay
    worstDay: BotStatsBestDay
    netProfitPerc: Float
    avgDaily: usdAssetNumber
    avgDailyPerc: Float
    annualizedReturn: FloatOrInfinity
    startBalance: usdAssetNumber
    maxDCAOrdersTriggered: Float
    avgDCAOrdersTriggered: Float
    coveredPriceDeviation: Float
    actualPriceDeviation: Float
    confidenceGrade: String
  }
  type botStatsNumericalRatiosBuyAndHold {
    result: FloatOrInfinity
    perc: FloatOrInfinity
    symbol: String
    startPrice: Float
  }
  type botStatsNumericalRatios {
    profitFactor: FloatOrInfinity
    sharpeRatio: Float
    sortinoRatio: Float
    cwr: Float
    buyAndHold: botStatsNumericalRatiosBuyAndHold
  }
  type botStatsNumericalUsage {
    maxTheoreticalUsage: Float
    maxActualUsage: Float
    avgDealUsage: Float
  }
  type botStatsNumericalDeals {
    profit: Float
    loss: Float
  }
  type botStatsNumerical {
    profit: botStatsNumericalProfit
    loss: botStatsNumericalLoss
    general: botStatsNumericalGeneral
    ratios: botStatsNumericalRatios
    usage: botStatsNumericalUsage
    deals: botStatsNumericalDeals
  }
  type botStatsDurationProfit {
    avgWinningTradeDuration: Float
    maxWinningTradeDuration: Float
    totalTime: Float
  }
  type botStatsDurationLoss {
    avgLosingTradeDuration: Float
    maxLosingTradeDuration: Float
    totalTime: Float
  }
  type botStatsDurationGeneral {
    maxDealDuration: Float
    avgDealDuration: Float
    dealsPerDay: Float
    workingTime: Float
    totalTime: Float
  }
  type botStatsDuration {
    profit: botStatsDurationProfit
    loss: botStatsDurationLoss
    general: botStatsDurationGeneral
  }
  type botStatsChart {
    realizedProfit: Float
    buyAndHold: Float
    equity: Float
    time: Float
  }
  type botStats {
    numerical: botStatsNumerical
    duration: botStatsDuration
    chart: [botStatsChart]
  }
  type botSymbolsStatsNumericalDeals {
    profit: Float
    loss: Float
  }
  type botSymbolsStatsNumericalGeneral {
    startBalance: usdAssetNumber
    netProfit: usdAssetNumber
    netProfitPerc: Float
    dailyProfit: usdAssetNumber
    dailyProfitPerc: Float
    winRate: Float
    profitFactor: FloatOrInfinity
  }
  type botSymbolsStatsDuration {
    maxDealDuration: Float
    avgDealDuration: Float
  }
  type botSymbolsStatsNumerical {
    deals: botSymbolsStatsNumericalDeals
    general: botSymbolsStatsNumericalGeneral
  }
  type botSymbolsStats {
    numerical: botSymbolsStatsNumerical
    duration: botSymbolsStatsDuration
    symbol: String
  }
  type fullDCABot {
    _id: String
    userId: String
    status: BotStatus
    statusReason: String
    coldArchived: Boolean
    showErrorWarning: String
    settings: DCABotSettings
    exchange: Exchange
    exchangeUUID: String
    created: Date
    updated: Date
    workingShift: [botWorkingShift]
    workingTimeNumber: Float
    unrealizedProfit: Float
    initialBalances: botMultiAsset
    currentBalances: botMultiAsset
    usdRate: [priceAssetMap]
    lastUsdRate: [priceAssetMap]
    lastPrice: [priceAssetMap]
    profit: Profit
    funding: Funding
    profitByAssets: [ProfitByAssets]
    symbol: [MultiPairSymbols]
    profitToday: ProfitToday
    public: Boolean
    assets: usedBotAssets
    usage: Usage
    dealsInBot: dealsInBot
    flags: [String]
    uuid: String
    share: Boolean
    shareId: String
    deals: [dcaDeal]
    orders: [botOrder]
    workingTimeTotal: Float
    exchangeUnassigned: Boolean
    vars: botVars
    hodlIgnoreAt: Boolean
    stats: botStats
    symbolStats: [botSymbolsStats]
    dealsReduceForBot: [dealsReduceForBot]
    notEnoughBalance: botNotEnoughBalance
    cost: Float
    liveStats: liveStats
  }
  type minigridSettings {
    topPrice: Float
    lowPrice: Float
    levels: Float
    budget: Float
    sellDisplacement: Float
    profitCurrency: String
    quoteFixedIn: String
  }
  enum ComboMinigridStatusEnum {
    active
    range
    closed
  }
  type FeePaid {
    base: FloatOrInfinity
    quote: FloatOrInfinity
  }
  type minigrids {
    _id: String
    botId: String
    userId: String
    dealId: String
    dcaOrderId: String
    grids: Level
    status: ComboMinigridStatusEnum
    initialBalances: botAsset
    currentBalances: botAsset
    initialPrice: Float
    realInitialPrice: Float
    lastPrice: Float
    profit: Profit
    feePaid: FeePaid
    avgPrice: Float
    createTime: Float
    updateTime: Float
    closeTime: Float
    assets: botAssets
    paperContext: Boolean
    exchange: String
    exchangeUUID: String
    symbol: Symbol
    settings: minigridSettings
    transactions: Level
  }
  type hedgeBalances {
    long: botMultiAsset
    short: botMultiAsset
  }
  type hedgeAssets {
    long: usedBotAssets
    short: usedBotAssets
  }
  type fullHedgeComboBot {
    _id: String
    created: Date
    updated: Date
    paperContext: Boolean
    profitByAssets: [ProfitByAssets]
    public: Boolean
    share: Boolean
    shareId: String
    showErrorWarning: String
    status: BotStatus
    statusReason: String
    coldArchived: Boolean
    userId: String
    workingShift: [botWorkingShift]
    bots: [fullComboBot]
    symbol: [MultiPairSymbols]
    profit: Profit
    dealsInBot: dealsInBot
    stats: botStats
    symbolStats: [botSymbolsStats]
    flags: [String]
    initialBalances: hedgeBalances
    currentBalances: hedgeBalances
    assets: hedgeAssets
    uuid: String
    sharedSettings: sharedSettings
    cost: Float
  }
  type fullComboBot {
    _id: String
    userId: String
    status: BotStatus
    statusReason: String
    coldArchived: Boolean
    showErrorWarning: String
    settings: ComboBotSettings
    exchange: Exchange
    exchangeUUID: String
    created: Date
    updated: Date
    workingShift: [botWorkingShift]
    workingTimeNumber: Float
    unrealizedProfit: Float
    initialBalances: botMultiAsset
    currentBalances: botMultiAsset
    usdRate: [priceAssetMap]
    lastUsdRate: [priceAssetMap]
    lastPrice: [priceAssetMap]
    profit: Profit
    funding: Funding
    profitByAssets: [ProfitByAssets]
    symbol: [MultiPairSymbols]
    profitToday: ProfitToday
    public: Boolean
    assets: usedBotAssets
    usage: Usage
    dealsInBot: dealsInBot
    flags: [String]
    uuid: String
    share: Boolean
    shareId: String
    deals: [dcaDeal]
    orders: [botOrder]
    minigrids: [minigrids]
    workingTimeTotal: Float
    exchangeUnassigned: Boolean
    vars: botVars
    dealsStatsForBot: [dealsStatsForBot]
    dealsReduceForBot: [dealsReduceForBot]
    hodlIgnoreAt: Boolean
    stats: botStats
    symbolStats: [botSymbolsStats]
    useAssets: Boolean
    notEnoughBalance: botNotEnoughBalance
    cost: Float
    liveStats: liveStats
  }
  type dealsReduceForBot {
    profit: Float
    profitUsd: Float
    base: Float
    quote: Float
    id: String
  }
  type dealsStatsForBot {
    dealId: String
    avgPrice: Float
    usage: Usage
    profit: Profit
    symbol: String
    currentBalances: baseQuote
    initialBalances: baseQuote
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    feePaid: FeePaid
  }
  type baseQuote {
    base: Float
    quote: Float
  }
  type usedAssets {
    used: Float
    required: Float
  }
  type priceAssetMap {
    key: String
    value: Float
  }
  input dcaDealSettingsInput {
    botId: String!
    dealId: String!
    settings: dcaDealSettingsInputSet
  }
  input comboDealSettingsInput {
    botId: String!
    dealId: String!
    settings: comboDealSettingsInputSet
  }
  input dcaDealSettingsInputSet {
    ordersCount: Int
    tpPerc: String
    slPerc: String
    profitCurrency: CurrencyEnum
    avgPrice: Float
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    dcaCustom: [dcaCustomInput]
    baseOrderSize: String
    baseOrderPrice: String
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum
    orderSize: String
    useTp: Boolean
    useSl: Boolean
    useDca: Boolean
    useSmartOrders: Boolean
    activeOrdersCount: Int
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    trailingSl: Boolean
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    dealCloseCondition: String
    dealCloseConditionSL: String
    trailingTp: Boolean
    trailingTpPerc: String
    useMinTP: Boolean
    minTp: String
    closeDealType: String
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    orderSizeType: String
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [inputMultiTP]
    useMultiTp: Boolean
    multiTp: [inputMultiTP]
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    step: String
    futures: Boolean
    coinm: Boolean
    leverage: Float
    marginType: BotMarginTypeEnum
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    comboUpperMinigrids: String
    comboLowerMinigrids: String
    feeOrder: Boolean
    comboActiveMinigrids: String
    useActiveMinigrids: Boolean
  }
  input comboDealSettingsInputSet {
    ordersCount: Int
    tpPerc: String
    slPerc: String
    profitCurrency: CurrencyEnum
    avgPrice: Float
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    dcaCustom: [dcaCustomInput]
    baseOrderSize: String
    baseOrderPrice: String
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum
    orderSize: String
    useTp: Boolean
    useSl: Boolean
    useDca: Boolean
    useSmartOrders: Boolean
    activeOrdersCount: Int
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    trailingSl: Boolean
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    dealCloseCondition: String
    dealCloseConditionSL: String
    trailingTp: Boolean
    trailingTpPerc: String
    useMinTP: Boolean
    minTp: String
    closeDealType: String
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    orderSizeType: String
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [inputMultiTP]
    useMultiTp: Boolean
    multiTp: [inputMultiTP]
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    step: String
    futures: Boolean
    coinm: Boolean
    leverage: Float
    marginType: BotMarginTypeEnum
    topPrice: String
    lowPrice: String
    useTrailing: Boolean
    topPricePerc: String
    lowPricePerc: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    gridLevel: String
    updatedComboAdjustments: Boolean
    feeOrder: Boolean
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
  }
  type dcaDealSettings {
    updatedComboAdjustments: Boolean
    ordersCount: Int
    tpPerc: String
    slPerc: String
    profitCurrency: CurrencyEnum
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    dcaCustom: [dcaCustomType]
    baseOrderSize: String
    baseOrderPrice: String
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum
    orderSize: String
    useTp: Boolean
    useSl: Boolean
    useDca: Boolean
    useSmartOrders: Boolean
    activeOrdersCount: Int
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    trailingSl: Boolean
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    dealCloseCondition: String
    dealCloseConditionSL: String
    trailingTp: Boolean
    trailingTpPerc: String
    useMinTP: Boolean
    minTp: String
    closeDealType: String
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    orderSizeType: String
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [multiTP]
    useMultiTp: Boolean
    multiTp: [multiTP]
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    avgPrice: Float
    changed: Boolean
    orderSizePercQty: Float
    step: String
    futures: Boolean
    coinm: Boolean
    leverage: Float
    marginType: BotMarginTypeEnum
    gridLevel: String
    feeOrder: Boolean
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
  }
  type comboDealSettings {
    updatedComboAdjustments: Boolean
    ordersCount: Int
    tpPerc: String
    slPerc: String
    profitCurrency: CurrencyEnum
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    dcaCustom: [dcaCustomType]
    baseOrderSize: String
    baseOrderPrice: String
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum
    orderSize: String
    useTp: Boolean
    useSl: Boolean
    useDca: Boolean
    useSmartOrders: Boolean
    activeOrdersCount: Int
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    trailingSl: Boolean
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    dealCloseCondition: String
    dealCloseConditionSL: String
    trailingTp: Boolean
    trailingTpPerc: String
    useMinTP: Boolean
    minTp: String
    closeDealType: String
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    orderSizeType: String
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [multiTP]
    useMultiTp: Boolean
    multiTp: [multiTP]
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    avgPrice: Float
    changed: Boolean
    orderSizePercQty: Float
    step: String
    futures: Boolean
    coinm: Boolean
    leverage: Float
    marginType: BotMarginTypeEnum
    gridLevel: String
    feeOrder: Boolean
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
  }
  enum trailingModeEnum {
    ttp
    tsl
  }
  type profitLossStats {
    drawdownPercent: FloatOrInfinity
    runUpPercent: FloatOrInfinity
    timeInProfit: Float
    timeInLoss: Float
    trackTime: Float
    timeCountStart: String
    currentCount: String
    unrealizedProfit: Float
  }
  type dynamicAr {
    value: Float
    id: String
  }
  type dealSizes {
    base: Float
    dca: [Float]
    origBase: Float
    origDca: [Float]
  }
  type filledHistory {
    id: String
    qty: Float
    price: Float
  }
  type dcaDeal {
    paperContext: Boolean
    parentBotId: String
    flags: [String]
    closeTrigger: String
    note: String
    _id: String
    botId: String
    botName: String
    userId: String
    status: DCADealStatusEnum
    initialBalances: botAsset
    currentBalances: botAsset
    feeBalance: Float
    newBalance: Boolean
    moveSlActivated: Boolean
    initialPrice: Float
    lastPrice: Float
    profit: Profit
    funding: Funding
    feePaid: FeePaid
    avgPrice: Float
    displayAvg: Float
    commission: Float
    createTime: Date
    updateTime: Date
    closeTime: Date
    levels: dcaLevels
    usage: Usage
    settings: dcaDealSettings
    orders: [botOrder]
    assets: botAssets
    dcaBot: [dcaDealBot]
    gridBreakpoints: [gridBreakpoint]
    strategy: StrategyEnum
    exchange: String
    exchangeUUID: String
    symbol: Symbol
    bestPrice: Float
    trailingMode: trailingModeEnum
    trailingLevel: Float
    stats: profitLossStats
    tpSlTargetFilled: [String]
    tpFilledHistory: [filledHistory]
    dynamicAr: [dynamicAr]
    funds: [dealFunds]
    reduceFunds: [dealFunds]
    pendingAddFunds: [pendingAddFunds]
    pendingReduceFunds: [pendingAddFunds]
    blockOrders: [blockOrders]
    cost: Float
    value: Float
    size: Float
    balanceStart: Float
    parent: Boolean
    sizes: dealSizes
    tags: [String]
    ac: dealAc
  }
  type dealAc {
    before: Float
    after: Float
  }
  type blockOrders {
    price: Float
    qty: Float
    side: orderSide
  }
  type pendingAddFunds {
    qty: String
    useLimitPrice: Boolean
    type: String
    limitPrice: String
    asset: String
    id: String
  }
  type dealFunds {
    price: Float
    qty: Float
  }
  type comboDeal {
    paperContext: Boolean
    parentBotId: String
    flags: [String]
    closeTrigger: String
    note: String
    _id: String
    botId: String
    botName: String
    userId: String
    status: DCADealStatusEnum
    initialBalances: botAsset
    currentBalances: botAsset
    feeBalance: Float
    newBalance: Boolean
    moveSlActivated: Boolean
    initialPrice: Float
    lastPrice: Float
    profit: Profit
    funding: Funding
    feePaid: FeePaid
    avgPrice: Float
    displayAvg: Float
    commission: Float
    createTime: Date
    updateTime: Date
    closeTime: Date
    levels: dcaLevels
    usage: Usage
    settings: comboDealSettings
    orders: [botOrder]
    assets: botAssets
    dcaBot: [dcaDealBot]
    gridBreakpoints: [gridBreakpoint]
    strategy: StrategyEnum
    exchange: String
    exchangeUUID: String
    symbol: Symbol
    bestPrice: Float
    trailingMode: trailingModeEnum
    trailingLevel: Float
    stats: profitLossStats
    tpSlTargetFilled: [String]
    tpFilledHistory: [filledHistory]
    dynamicAr: [dynamicAr]
    cost: Float
    value: Float
    size: Float
    balanceStart: Float
    transactions: comboTransactions
    sizes: dealSizes
    tags: [String]
    ac: dealAc
  }
  type comboTransactions {
    buy: Float
    sell: Float
  }
  type gridBreakpoint {
    price: Float
    displacedPrice: Float
  }
  type dcaDealBot {
    settings: DCABotSettings
    symbol: Symbol
    _id: String
    status: BotStatus
    public: Boolean
    exchange: Exchange
  }
  type getDCADealsResult {
    page: Int
    totalPages: Int
    totalResults: Int
    result: [dcaDeal]
  }
  type getComboDealsResult {
    page: Int
    totalPages: Int
    totalResults: Int
    result: [comboDeal]
  }
  type getDCADealsResponse implements BasicResponse {
    status: Status
    reason: String
    data: getDCADealsResult
    total: Float
  }
  type getComboDealsResponse implements BasicResponse {
    status: Status
    reason: String
    data: getComboDealsResult
    total: Float
  }
  type getTradingTerminalBotsListResponse implements BasicResponse {
    status: Status
    reason: String
    data: [fullDCABot]
  }
  type dcaLevels {
    all: Int
    complete: Int
  }
  enum DCADealStatusEnum {
    open
    closed
    error
    start
    canceled
  }
  enum IndicatorStartConditionEnum {
    cd
    cu
    gt
    lt
  }
  enum rsiValueEnum {
    k
    d
  }
  enum rsiValue2Enum {
    k
    d
    custom
  }
  enum TradingviewAnalysisSignalEnum {
    strongBuy
    strongSell
    buy
    sell
    bothBuy
    bothSell
  }
  enum TradingviewAnalysisConditionEnum {
    every
    entry
  }
  type ProfitToday {
    start: Date
    end: Date
    totalToday: Float
    totalTodayUsd: Float
  }
  type Profit {
    total: FloatOrInfinity
    totalUsd: FloatOrInfinity
    freeTotal: FloatOrInfinity
    freeTotalUsd: FloatOrInfinity
    pureBase: FloatOrInfinity
    pureQuote: FloatOrInfinity
    gridProfit: FloatOrInfinity
    gridProfitUsd: FloatOrInfinity
  }
  type ProfitByAssets {
    asset: String
    total: FloatOrInfinity
    totalUsd: FloatOrInfinity
  }
  type FundingHistoryEntry {
    time: Float
    rate: Float
    markPrice: Float
    qty: Float
    feeQuote: Float
    feeUsd: Float
  }
  type Funding {
    total: FloatOrInfinity
    totalUsd: FloatOrInfinity
    lastTime: Float
    history: [FundingHistoryEntry]
  }
  type Symbol {
    symbol: String
    baseAsset: String
    quoteAsset: String
  }
  type MultiPairSymbols {
    key: String
    value: MultiPairSymbol
  }
  type MultiPairSymbol {
    symbol: String
    baseAsset: String
    quoteAsset: String
  }
  type botAssets {
    used: botAsset
    required: botAsset
  }
  type MultiPairBotAssets {
    key: String
    value: Float
  }
  type botAsset {
    base: FloatOrInfinity
    quote: FloatOrInfinity
  }
  type getBotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullBot
  }
  type getDCABotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullDCABot
  }
  type getHedgeComboBotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullHedgeComboBot
  }
  type getComboBotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullComboBot
  }
  type createBotResponseData {
    botId: String
  }
  type createBotResponse implements BasicResponse {
    status: Status
    reason: String
    data: createBotResponseData
  }
  type createDCABotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullDCABot
  }
  type createComboBotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullComboBot
  }
  type createHedgeComboBotResponse implements BasicResponse {
    status: Status
    reason: String
    data: fullHedgeComboBot
  }
  enum GridTypeEnum {
    geometric
    arithmetic
  }
  input createBotInput {
    vars: botVarsInput
    pair: String!
    name: String
    topPrice: Float!
    lowPrice: Float!
    levels: Int!
    gridStep: Float!
    budget: Float!
    ordersInAdvance: Float!
    useOrderInAdvance: Boolean!
    prioritize: Prioritize!
    profitCurrency: CurrencyEnum!
    orderFixedIn: CurrencyEnum!
    sellDisplacement: Float!
    gridType: GridTypeEnum!
    tpSl: Boolean
    tpSlCondition: TpSlConditionEnum
    tpSlAction: TpSlActionEnum
    sl: Boolean
    slCondition: TpSlConditionEnum
    slAction: TpSlActionEnum
    tpPerc: Float
    slPerc: Float
    tpTopPrice: Float
    slLowPrice: Float
    baseAsset: String
    quoteAsset: String
    exchange: Exchange!
    exchangeUUID: String!
    useStartPrice: Boolean
    startPrice: String
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    newProfit: Boolean
    newBalance: Boolean
    strategy: StrategyEnum
    futuresStrategy: FuturesStrategyEnum
    slLimit: Boolean
    tpSlLimit: Boolean
    feeOrder: Boolean
    skipBalanceCheck: Boolean
  }
  enum FuturesStrategyEnum {
    LONG
    SHORT
    NEUTRAL
  }
  enum StrategyEnum {
    LONG
    SHORT
  }
  enum OrderTypeEnum {
    LIMIT
    MARKET
  }
  enum StartConditionEnum {
    ASAP
    Manual
    TradingviewSignals
    Timer
    TechnicalIndicators
  }
  enum IndicatorsEnum {
    RSI
    ADX
    BBW
    BBPB
    MACD
    EMA
    TV
    MA
    BB
    BullBear
    Stoch
    StochRSI
    SR
    QFL
    MFI
    PSAR
    VO
    CCI
    AO
    WR
    UO
    MOM
    BBWP
    ECD
    XO
    MAR
    DIV
    ST
    PC
    ATR
    ADR
    ATH
    PP
    KC
    KCPB
    UNPNL
    DC
    OBFVG
    LW
    SESSION
  }
  enum BBCrossingEnum {
    middle
    upper
    lower
  }
  enum SRCrossingEnum {
    support
    resistance
  }
  input indicatorGroups {
    id: String
    logic: String
    action: String
    section: String
  }
  input indicatorSettings {
    indicatorLength: Int
    indicatorValue: String
    indicatorCondition: String
    groupId: String
    indicatorInterval: String
    type: String
    uuid: String
    signal: String
    condition: String
    checkLevel: Int
    maType: String
    maCrossingValue: String
    maCrossingLength: Int
    maCrossingInterval: String
    maUUID: String
    bbCrossingValue: String
    stochSmoothK: Int
    stochSmoothD: Int
    stochUpper: String
    stochLower: String
    stochRSI: Int
    valueInsteadof: Float
    rsiValue: String
    rsiValue2: String
    srCrossingValue: String
    leftBars: Int
    rightBars: Int
    basePeriods: Int
    pumpPeriods: Int
    pump: Float
    baseCrack: Float
    indicatorAction: String
    section: String
    psarStart: Float
    psarInc: Float
    psarMax: Float
    stochRange: String
    minPercFromLast: String
    orderSize: String
    keepConditionBars: String
    voShort: Float
    voLong: Float
    uoFast: Float
    uoMiddle: Float
    uoSlow: Float
    momSource: String
    bbwpLookback: Float
    ecdTrigger: String
    xOscillator1: String
    xOscillator2: String
    xOscillator2length: Float
    xOscillator2Interval: String
    xOscillator2voLong: Float
    xOscillator2voShort: Float
    xoUUID: String
    percentile: Boolean
    percentileLookback: Float
    percentilePercentage: Float
    mar1length: Float
    mar1type: String
    mar2length: Float
    mar2type: String
    bbwMult: Float
    bbwMa: String
    bbwMaLength: Float
    macdFast: Float
    macdSlow: Float
    macdMaSource: String
    macdMaSignal: String
    divOscillators: [String]
    divType: String
    divMinCount: Float
    trendFilter: Boolean
    trendFilterLookback: Float
    trendFilterType: String
    trendFilterValue: Float
    factor: Float
    atrLength: Float
    stCondition: String
    pcUp: String
    pcDown: String
    pcCondition: String
    pcValue: String
    ppHighLeft: Float
    ppHighRight: Float
    ppLowLeft: Float
    ppLowRight: Float
    ppMult: Float
    ppValue: String
    ppType: String
    riskAtrMult: String
    dynamicArFactor: String
    athLookback: Float
    kcMa: String
    kcRange: String
    kcRangeLength: Float
    obfvgValue: String
    obfvgRef: String
    unpnlValue: Float
    unpnlCondition: String
    dcValue: String
    sessionDays: [Int]
    sessionRule: String
    lwMaxDuration: String
    lwThreshold: StringOrNumber
    lwValue: StringOrNumber
    lwCondition: String
  }
  enum IndicatorSection {
    sl
    tp
    dca
    controller
  }
  enum IndicatorActionEnum {
    startDeal
    closeDeal
    startDca
    stopBot
    startBot
  }
  enum DCAConditionEnum {
    percentage
    indicators
    custom
    dynamicAr
  }
  input dcaCustomInput {
    uuid: String
    size: String
    step: String
  }
  type dcaCustomType {
    uuid: String
    size: String
    step: String
  }
  input createDCABotInput {
    vars: botVarsInput
    pair: [String!]!
    name: String
    strategy: StrategyEnum!
    profitCurrency: CurrencyEnum!
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    skipBalanceCheck: Boolean
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    maxDealsPerHigherTimeframe: String
    useMaxDealsPerHigherTimeframe: Boolean
    remainderFullAmount: Boolean
    autoRebalancing: Boolean
    adaptiveClose: Boolean
    useStaticPriceFilter: Boolean
    useCooldown: Boolean
    useVolumeFilterAll: Boolean
    useDynamicPriceFilter: Boolean
    dynamicPriceFilterDeviation: String
    dynamicPriceFilterOverValue: String
    dynamicPriceFilterUnderValue: String
    dynamicPriceFilterPriceType: String
    useNoOverlapDeals: Boolean
    dynamicPriceFilterDirection: String
    useRiskReward: Boolean
    rrSlType: String
    rrSlFixedValue: String
    riskSlType: String
    riskSlAmountPerc: String
    riskSlAmountValue: String
    riskUseTpRatio: Boolean
    riskTpRatio: String
    riskMinPositionSize: String
    scaleDcaType: String
    startDealLogic: String
    stopDealLogic: String
    stopDealSlLogic: String
    stopBotLogic: String
    useRiskReduction: Boolean
    riskReductionValue: String
    useReinvest: Boolean
    reinvestValue: String
    startBotPriceCondition: String
    startBotPriceValue: String
    stopBotPriceCondition: String
    stopBotPriceValue: String
    startBotLogic: String
    botActualStart: BotStartTypeEnum
    riskMaxPositionSize: String
    dynamicArLockValue: Boolean
    riskMaxSl: String
    riskMinSl: String
    dcaCustom: [dcaCustomInput]
    baseOrderSize: String!
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum!
    startCondition: StartConditionEnum!
    tpPerc: String
    slPerc: String
    orderFixedIn: CurrencyEnum!
    orderSize: String!
    step: String
    ordersCount: Int
    activeOrdersCount: Int
    volumeScale: String!
    stepScale: String!
    minimumDeviation: String
    baseAsset: [String]
    quoteAsset: [String]
    useTp: Boolean!
    useSl: Boolean!
    useSmartOrders: Boolean!
    minOpenDeal: String
    maxOpenDeal: String
    useDca: Boolean!
    hodlAt: String
    hodlHourly: Boolean
    hodlDay: String
    hodlNextBuy: Float
    exchange: Exchange
    exchangeUUID: String
    maxNumberOfOpenDeals: String
    indicators: [indicatorSettings]
    indicatorGroups: [indicatorGroups]
    type: DCATypeEnum
    baseOrderPrice: String
    orderSizeType: OrderSizeTypeEnum
    limitTimeout: String
    useLimitTimeout: Boolean
    notUseLimitReposition: Boolean
    cooldownAfterDealStart: Boolean
    cooldownAfterDealStartUnits: CooldownUnits
    cooldownAfterDealStartInterval: Int
    cooldownAfterDealStop: Boolean
    cooldownAfterDealStopUnits: CooldownUnits
    cooldownAfterDealStopInterval: Int
    cooldownAfterDealStartOption: String
    cooldownAfterDealStopOption: String
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    trailingSl: Boolean
    trailingTp: Boolean
    trailingTpPerc: String
    useCloseAfterX: Boolean
    useCloseAfterXwin: Boolean
    closeAfterXwin: String
    useCloseAfterXloss: Boolean
    closeAfterXloss: String
    useCloseAfterXprofit: Boolean
    closeAfterXprofitValue: String
    closeAfterXprofitCond: String
    closeAfterX: String
    useMulti: Boolean
    maxDealsPerPair: String
    ignoreStartDeals: Boolean
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    useCloseAfterXopen: Boolean
    closeAfterXopen: String
    botStart: BotStartTypeEnum
    useBotController: Boolean
    stopType: CloseDCATypeEnum
    stopStatus: BotStatus
    dealCloseCondition: CloseConditionEnum
    dealCloseConditionSL: CloseConditionEnum
    useMinTP: Boolean
    minTp: String
    closeDealType: CloseDCATypeEnum
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    terminalDealType: TerminalDealTypeEnum
    useMultiTp: Boolean
    multiTp: [inputMultiTP]
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [inputMultiTP]
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    importFrom: String
    gridLevel: String
    feeOrder: Boolean
    useVolumeFilter: Boolean
    volumeTop: String
    volumeValue: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    useRelativeVolumeFilter: Boolean
    relativeVolumeTop: String
    relativeVolumeValue: String
    uuid: String
    useSeparateMaxDealsOverAndUnder: Boolean
    maxDealsOver: String
    maxDealsUnder: String
    useSeparateMaxDealsOverAndUnderPerSymbol: Boolean
    maxDealsOverPerSymbol: String
    maxDealsUnderPerSymbol: String
  }
  input sharedSettingsInput {
    useSl: Boolean
    useTp: Boolean
    slPerc: String
    tpPerc: String
    comboTpBase: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    dealCloseConditionSL: String
    dealCloseCondition: String
  }
  type sharedSettings {
    useSl: Boolean
    useTp: Boolean
    slPerc: String
    tpPerc: String
    comboTpBase: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    dealCloseConditionSL: String
    dealCloseCondition: String
  }
  input createHedgeComboBotInput {
    long: createComboBotInput!
    short: createComboBotInput!
    sharedSettings: sharedSettingsInput
  }
  input botVarsInput {
    list: [String]
    paths: [botVarsInputPath]
  }
  input botVarsInputPath {
    path: String
    variable: String
  }
  input createComboBotInput {
    vars: botVarsInput
    pair: [String!]!
    name: String
    strategy: StrategyEnum!
    profitCurrency: CurrencyEnum!
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    skipBalanceCheck: Boolean
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    maxDealsPerHigherTimeframe: String
    useMaxDealsPerHigherTimeframe: Boolean
    remainderFullAmount: Boolean
    autoRebalancing: Boolean
    adaptiveClose: Boolean
    useStaticPriceFilter: Boolean
    useCooldown: Boolean
    useVolumeFilterAll: Boolean
    useDynamicPriceFilter: Boolean
    dynamicPriceFilterDeviation: String
    dynamicPriceFilterOverValue: String
    dynamicPriceFilterUnderValue: String
    dynamicPriceFilterPriceType: String
    useNoOverlapDeals: Boolean
    dynamicPriceFilterDirection: String
    useRiskReward: Boolean
    rrSlType: String
    rrSlFixedValue: String
    riskSlType: String
    riskSlAmountPerc: String
    riskSlAmountValue: String
    riskUseTpRatio: Boolean
    riskTpRatio: String
    riskMinPositionSize: String
    scaleDcaType: String
    startDealLogic: String
    stopDealLogic: String
    stopDealSlLogic: String
    stopBotLogic: String
    useRiskReduction: Boolean
    riskReductionValue: String
    useReinvest: Boolean
    reinvestValue: String
    startBotPriceCondition: String
    startBotPriceValue: String
    stopBotPriceCondition: String
    stopBotPriceValue: String
    startBotLogic: String
    botActualStart: BotStartTypeEnum
    riskMaxPositionSize: String
    dynamicArLockValue: Boolean
    riskMaxSl: String
    riskMinSl: String
    dcaCustom: [dcaCustomInput]
    baseOrderSize: String!
    useLimitPrice: Boolean
    startOrderType: OrderTypeEnum!
    startCondition: StartConditionEnum!
    tpPerc: String
    slPerc: String
    orderFixedIn: CurrencyEnum!
    orderSize: String!
    step: String
    ordersCount: Int
    activeOrdersCount: Int
    volumeScale: String!
    stepScale: String!
    minimumDeviation: String
    baseAsset: [String]
    quoteAsset: [String]
    useTp: Boolean!
    useSl: Boolean!
    useSmartOrders: Boolean!
    minOpenDeal: String
    maxOpenDeal: String
    useDca: Boolean!
    hodlAt: String
    hodlHourly: Boolean
    hodlDay: String
    hodlNextBuy: Float
    exchange: Exchange
    exchangeUUID: String
    maxNumberOfOpenDeals: String
    indicators: [indicatorSettings]
    indicatorGroups: [indicatorGroups]
    type: DCATypeEnum
    baseOrderPrice: String
    orderSizeType: OrderSizeTypeEnum
    limitTimeout: String
    useLimitTimeout: Boolean
    notUseLimitReposition: Boolean
    cooldownAfterDealStart: Boolean
    cooldownAfterDealStartUnits: CooldownUnits
    cooldownAfterDealStartInterval: Int
    cooldownAfterDealStop: Boolean
    cooldownAfterDealStopUnits: CooldownUnits
    cooldownAfterDealStopInterval: Int
    cooldownAfterDealStartOption: String
    cooldownAfterDealStopOption: String
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    trailingSl: Boolean
    trailingTp: Boolean
    trailingTpPerc: String
    useCloseAfterX: Boolean
    useCloseAfterXwin: Boolean
    closeAfterXwin: String
    useCloseAfterXloss: Boolean
    closeAfterXloss: String
    useCloseAfterXprofit: Boolean
    closeAfterXprofitValue: String
    closeAfterXprofitCond: String
    closeAfterX: String
    useMulti: Boolean
    maxDealsPerPair: String
    ignoreStartDeals: Boolean
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    useCloseAfterXopen: Boolean
    closeAfterXopen: String
    botStart: BotStartTypeEnum
    useBotController: Boolean
    stopType: CloseDCATypeEnum
    stopStatus: BotStatus
    dealCloseCondition: CloseConditionEnum
    dealCloseConditionSL: CloseConditionEnum
    useMinTP: Boolean
    minTp: String
    closeDealType: CloseDCATypeEnum
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    terminalDealType: TerminalDealTypeEnum
    useMultiTp: Boolean
    multiTp: [inputMultiTP]
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [inputMultiTP]
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    gridLevel: String
    feeOrder: Boolean
    useVolumeFilter: Boolean
    volumeTop: String
    volumeValue: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    newBalance: Boolean
    useRelativeVolumeFilter: Boolean
    relativeVolumeTop: String
    relativeVolumeValue: String
    useSeparateMaxDealsOverAndUnder: Boolean
    maxDealsOver: String
    maxDealsUnder: String
    useSeparateMaxDealsOverAndUnderPerSymbol: Boolean
    maxDealsOverPerSymbol: String
    maxDealsUnderPerSymbol: String
  }
  enum BotMarginTypeEnum {
    inherit
    cross
    isolated
  }
  enum TerminalDealTypeEnum {
    smart
    simple
    import
  }
  input LimitTimeoutInput {
    h: Int
    m: Int
    s: Int
  }
  enum DCATypeEnum {
    regular
    terminal
  }
  input changeDCABotInput {
    vars: botVarsInput
    id: String!
    name: String
    pair: [String]
    strategy: StrategyEnum
    profitCurrency: CurrencyEnum
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    skipBalanceCheck: Boolean
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    maxDealsPerHigherTimeframe: String
    useMaxDealsPerHigherTimeframe: Boolean
    remainderFullAmount: Boolean
    autoRebalancing: Boolean
    adaptiveClose: Boolean
    useStaticPriceFilter: Boolean
    useCooldown: Boolean
    useVolumeFilterAll: Boolean
    useDynamicPriceFilter: Boolean
    dynamicPriceFilterDeviation: String
    dynamicPriceFilterOverValue: String
    dynamicPriceFilterUnderValue: String
    dynamicPriceFilterPriceType: String
    useNoOverlapDeals: Boolean
    dynamicPriceFilterDirection: String
    useRiskReward: Boolean
    rrSlType: String
    rrSlFixedValue: String
    riskSlType: String
    riskSlAmountPerc: String
    riskSlAmountValue: String
    riskUseTpRatio: Boolean
    riskTpRatio: String
    riskMinPositionSize: String
    scaleDcaType: String
    startDealLogic: String
    stopDealLogic: String
    stopDealSlLogic: String
    stopBotLogic: String
    useRiskReduction: Boolean
    riskReductionValue: String
    useReinvest: Boolean
    reinvestValue: String
    startBotPriceCondition: String
    startBotPriceValue: String
    stopBotPriceCondition: String
    stopBotPriceValue: String
    startBotLogic: String
    botActualStart: BotStartTypeEnum
    riskMaxPositionSize: String
    dynamicArLockValue: Boolean
    riskMaxSl: String
    riskMinSl: String
    dcaCustom: [dcaCustomInput]
    baseOrderSize: String
    baseOrderPrice: String
    startOrderType: OrderTypeEnum
    startCondition: StartConditionEnum
    tpPerc: String
    orderFixedIn: CurrencyEnum
    orderSize: String
    step: String
    ordersCount: Int
    activeOrdersCount: Int
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    baseAsset: String
    quoteAsset: String
    useTp: Boolean
    useSl: Boolean
    slPerc: String
    useSmartOrders: Boolean
    minOpenDeal: String
    maxOpenDeal: String
    useDca: Boolean
    hodlAt: String
    hodlHourly: Boolean
    hodlDay: String
    hodlNextBuy: Float
    maxNumberOfOpenDeals: String
    indicatorInterval: String
    indicators: [indicatorSettings]
    indicatorGroups: [indicatorGroups]
    limitTimeout: String
    useLimitTimeout: Boolean
    notUseLimitReposition: Boolean
    cooldownAfterDealStart: Boolean
    cooldownAfterDealStartUnits: CooldownUnits
    cooldownAfterDealStartInterval: Int
    cooldownAfterDealStop: Boolean
    cooldownAfterDealStopUnits: CooldownUnits
    cooldownAfterDealStopInterval: Int
    cooldownAfterDealStartOption: String
    cooldownAfterDealStopOption: String
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    trailingSl: Boolean
    trailingTp: Boolean
    trailingTpPerc: String
    useCloseAfterX: Boolean
    useCloseAfterXwin: Boolean
    closeAfterXwin: String
    useCloseAfterXloss: Boolean
    closeAfterXloss: String
    useCloseAfterXprofit: Boolean
    closeAfterXprofitValue: String
    closeAfterXprofitCond: String
    closeAfterX: String
    maxDealsPerPair: String
    ignoreStartDeals: Boolean
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    useCloseAfterXopen: Boolean
    closeAfterXopen: String
    botStart: BotStartTypeEnum
    useBotController: Boolean
    stopType: CloseDCATypeEnum
    stopStatus: BotStatus
    dealCloseCondition: CloseConditionEnum
    dealCloseConditionSL: CloseConditionEnum
    useMinTP: Boolean
    minTp: String
    closeDealType: CloseDCATypeEnum
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    orderSizeType: OrderSizeTypeEnum
    useMultiTp: Boolean
    multiTp: [inputMultiTP]
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [inputMultiTP]
    leverage: Float
    marginType: BotMarginTypeEnum
    futures: Boolean
    coinm: Boolean
    useVolumeFilter: Boolean
    volumeTop: String
    volumeValue: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    comboUpperMinigrids: String
    comboLowerMinigrids: String
    useRelativeVolumeFilter: Boolean
    relativeVolumeTop: String
    relativeVolumeValue: String
    useSeparateMaxDealsOverAndUnder: Boolean
    maxDealsOver: String
    maxDealsUnder: String
    useSeparateMaxDealsOverAndUnderPerSymbol: Boolean
    maxDealsOverPerSymbol: String
    maxDealsUnderPerSymbol: String
  }
  input changeHedgeComboBotInput {
    long: changeComboBotInput!
    short: changeComboBotInput!
    id: String!
    sharedSettings: sharedSettingsInput
  }
  input changeComboBotInput {
    vars: botVarsInput
    id: String!
    name: String
    pair: [String]
    strategy: StrategyEnum
    profitCurrency: CurrencyEnum
    dcaCondition: DCAConditionEnum
    dcaVolumeBaseOn: String
    dcaVolumeRequiredChange: String
    dcaVolumeRequiredChangeRef: String
    dcaVolumeMaxValue: String
    skipBalanceCheck: Boolean
    baseSlOn: String
    closeByTimer: Boolean
    closeByTimerValue: Float
    closeByTimerUnits: CooldownUnits
    maxDealsPerHigherTimeframe: String
    useMaxDealsPerHigherTimeframe: Boolean
    remainderFullAmount: Boolean
    autoRebalancing: Boolean
    adaptiveClose: Boolean
    useStaticPriceFilter: Boolean
    useCooldown: Boolean
    useVolumeFilterAll: Boolean
    useDynamicPriceFilter: Boolean
    dynamicPriceFilterDeviation: String
    dynamicPriceFilterOverValue: String
    dynamicPriceFilterUnderValue: String
    dynamicPriceFilterPriceType: String
    useNoOverlapDeals: Boolean
    dynamicPriceFilterDirection: String
    useRiskReward: Boolean
    rrSlType: String
    rrSlFixedValue: String
    riskSlType: String
    riskSlAmountPerc: String
    riskSlAmountValue: String
    riskUseTpRatio: Boolean
    riskTpRatio: String
    riskMinPositionSize: String
    scaleDcaType: String
    startDealLogic: String
    stopDealLogic: String
    stopDealSlLogic: String
    stopBotLogic: String
    useRiskReduction: Boolean
    riskReductionValue: String
    useReinvest: Boolean
    reinvestValue: String
    startBotPriceCondition: String
    startBotPriceValue: String
    stopBotPriceCondition: String
    stopBotPriceValue: String
    startBotLogic: String
    botActualStart: BotStartTypeEnum
    riskMaxPositionSize: String
    dynamicArLockValue: Boolean
    riskMaxSl: String
    riskMinSl: String
    dcaCustom: [dcaCustomInput]
    baseOrderSize: String
    baseOrderPrice: String
    startOrderType: OrderTypeEnum
    startCondition: StartConditionEnum
    tpPerc: String
    orderFixedIn: CurrencyEnum
    orderSize: String
    step: String
    ordersCount: Int
    activeOrdersCount: Int
    volumeScale: String
    stepScale: String
    minimumDeviation: String
    baseAsset: String
    quoteAsset: String
    useTp: Boolean
    useSl: Boolean
    slPerc: String
    useSmartOrders: Boolean
    minOpenDeal: String
    maxOpenDeal: String
    useDca: Boolean
    hodlAt: String
    hodlHourly: Boolean
    hodlDay: String
    hodlNextBuy: Float
    maxNumberOfOpenDeals: String
    indicatorInterval: String
    indicators: [indicatorSettings]
    indicatorGroups: [indicatorGroups]
    limitTimeout: String
    useLimitTimeout: Boolean
    notUseLimitReposition: Boolean
    cooldownAfterDealStart: Boolean
    cooldownAfterDealStartUnits: CooldownUnits
    cooldownAfterDealStartInterval: Int
    cooldownAfterDealStop: Boolean
    cooldownAfterDealStopUnits: CooldownUnits
    cooldownAfterDealStopInterval: Int
    cooldownAfterDealStartOption: String
    cooldownAfterDealStopOption: String
    moveSL: Boolean
    moveSLTrigger: String
    moveSLValue: String
    moveSLForAll: Boolean
    trailingSl: Boolean
    trailingTp: Boolean
    trailingTpPerc: String
    useCloseAfterX: Boolean
    useCloseAfterXwin: Boolean
    closeAfterXwin: String
    useCloseAfterXloss: Boolean
    closeAfterXloss: String
    useCloseAfterXprofit: Boolean
    closeAfterXprofitValue: String
    closeAfterXprofitCond: String
    closeAfterX: String
    maxDealsPerPair: String
    ignoreStartDeals: Boolean
    comboTpBase: String
    comboSmartGridsCount: String
    comboUseSmartGrids: Boolean
    useCloseAfterXopen: Boolean
    closeAfterXopen: String
    botStart: BotStartTypeEnum
    useBotController: Boolean
    stopType: CloseDCATypeEnum
    stopStatus: BotStatus
    dealCloseCondition: CloseConditionEnum
    dealCloseConditionSL: CloseConditionEnum
    useMinTP: Boolean
    minTp: String
    closeDealType: CloseDCATypeEnum
    closeOrderType: OrderTypeEnum
    dcaByMarket: Boolean
    orderSizeType: OrderSizeTypeEnum
    useMultiTp: Boolean
    multiTp: [inputMultiTP]
    useMultiSl: Boolean
    pairPrioritization: String
    multiSl: [inputMultiTP]
    leverage: Float
    marginType: BotMarginTypeEnum
    futures: Boolean
    coinm: Boolean
    topPrice: String
    lowPrice: String
    useTrailing: Boolean
    topPricePerc: String
    lowPricePerc: String
    gridLevel: String
    feeOrder: Boolean
    useVolumeFilter: Boolean
    volumeTop: String
    volumeValue: String
    useFixedTPPrices: Boolean
    useFixedSLPrices: Boolean
    fixedTpPrice: String
    fixedSlPrice: String
    baseStep: String
    baseGridLevels: String
    useActiveMinigrids: Boolean
    comboActiveMinigrids: String
    comboSlLimit: Boolean
    comboTpLimit: Boolean
    newBalance: Boolean
    useRelativeVolumeFilter: Boolean
    relativeVolumeTop: String
    relativeVolumeValue: String
    useSeparateMaxDealsOverAndUnder: Boolean
    maxDealsOver: String
    maxDealsUnder: String
    useSeparateMaxDealsOverAndUnderPerSymbol: Boolean
    maxDealsOverPerSymbol: String
    maxDealsUnderPerSymbol: String
  }
  input changeBotInput {
    vars: botVarsInput
    name: String
    pair: String
    id: String!
    topPrice: Float
    lowPrice: Float
    levels: Int
    gridStep: Float
    budget: Float
    ordersInAdvance: Float
    useOrderInAdvance: Boolean
    prioritize: Prioritize
    profitCurrency: CurrencyEnum
    orderFixedIn: CurrencyEnum
    sellDisplacement: Float
    gridType: GridTypeEnum
    tpSl: Boolean
    tpSlCondition: TpSlConditionEnum
    tpSlAction: TpSlActionEnum
    sl: Boolean
    slCondition: TpSlConditionEnum
    slAction: TpSlActionEnum
    tpPerc: Float
    slPerc: Float
    tpTopPrice: Float
    slLowPrice: Float
    initialPrice: Float
    buyType: String
    buyCount: String
    buyAmount: Float
    useStartPrice: Boolean
    startPrice: String
    marginType: BotMarginTypeEnum
    leverage: Float
    futures: Boolean
    coinm: Boolean
    futuresStrategy: FuturesStrategyEnum
    strategy: StrategyEnum
    slLimit: Boolean
    tpSlLimit: Boolean
    feeOrder: Boolean
    skipBalanceCheck: Boolean
  }
  enum CloseGRIDTypeEnum {
    cancel
    closeByLimit
    closeByMarket
  }
  input changeStatusHedgeConfigInput {
    LONG: String
    SHORT: String
  }
  input changeStatusInput {
    id: String!
    status: BotStatus!
    cancelPartiallyFilled: Boolean
    type: botTypeEnum
    closeType: CloseDCATypeEnum
    buyType: String
    buyCount: String
    buyAmount: Float
    closeGridType: CloseGRIDTypeEnum
    hedgeConfig: changeStatusHedgeConfigInput
  }
  input restartBotInput {
    id: String!
    type: botTypeEnum
  }
  input restartMultiPairBotInput {
    id: String!
  }
  input deleteBotMessageInput {
    id: String
  }
  enum botTypeEnum {
    grid
    dca
    combo
    hedgeCombo
    hedgeDca
  }
  input deleteBotInput {
    id: String!
    type: botTypeEnum
  }
  type deleteBotResponse implements BasicResponse {
    status: Status
    reason: String
  }
  type deleteBotMessageResponse implements BasicResponse {
    status: Status
    reason: String
  }
  type updateDCADealSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  type updateComboDealSettingsResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
  input getProfitByBot {
    botId: String!
    timezone: String
    timeframe: Int
    botType: botTypeEnum
  }
  input getProfitByUser {
    botType: botTypeEnum
    timezone: String
    timeframe: Int
    terminal: Boolean
  }
  input getPortfolioByUser {
    timezone: String
    from: Float
    to: Float
    includeAssets: Boolean
  }
  type getProfitData {
    quote: Float
    base: Float
    profitUsd: Float
    date: Date
  }
  type getProfitResult {
    result: [getProfitData]
  }
  type getProfitResponse implements BasicResponse {
    status: Status
    reason: String
    data: getProfitResult
  }
  type assetUsdDataExchangesData {
    uuid: String
    amount: Float
    amountUsd: Float
  }
  type assetUsdData {
    name: String
    amount: Float
    amountUsd: Float
    exchanges: [assetUsdDataExchangesData]
  }
  type exchangesInPortfolio {
    uuid: String
    totalUsd: Float
  }
  type getPortfolioData {
    updateTime: Float
    totalUsd: Float
    assets: [assetUsdData]
    exchangesTotal: [exchangesInPortfolio]
    updated: Float
  }
  type getPortfolioResult {
    result: [getPortfolioData]
  }
  type getPortfolioResponse implements BasicResponse {
    status: Status
    reason: String
    data: getPortfolioResult
  }
  type getLatestOrdersResponseData {
    result: [botOrder]
  }
  input getLatestOrdersInput {
    page: Int
  }
  type getLatestOrdersResponse implements BasicResponse {
    status: Status
    reason: String
    data: getLatestOrdersResponseData
    total: Int
  }
  input mergeDealsInput {
    botId: String!
    dealIds: [String!]!
  }
  type mergeDealsResponse implements BasicResponse {
    status: Status
    reason: String
    data: String
  }
`

export const GlobalVariablesSchema = /* GraphQL */ `
  enum GlobalVariableTypeEnum {
    text
    int
    float
  }
  type RelatedBot {
    id: String!
    name: String!
  }
  type GlobalVariables {
    id: ID!
    name: String!
    type: GlobalVariableTypeEnum!
    value: String!
    botAmount: Int!
  }
  type Query {
    getGlobalVariables(input: GetGlobalVariablesInput): GlobalVariablesResponse
    getGlobalVariableRelatedBots(
      input: getGlobalVariableRelatedBotsInput
    ): getGlobalVariableRelatedBotsResponse
    getGlobalVariablesByIds(
      input: GetGlobalVariablesByIdsInput
    ): GlobalVariablesResponse
  }
  type Mutation {
    deleteGlobalVariable(
      input: DeleteGlobalVariableInput!
    ): DeleteGlobalVariableResponse
    createGlobalVariable(
      input: CreateGlobalVariableInput!
    ): CreateGlobalVariableResponse
    updateGlobalVariable(
      input: UpdateGlobalVariableInput!
    ): UpdateGlobalVariableResponse
  }
  input getGlobalVariableRelatedBotsInput {
    id: String
  }
  type getGlobalVariableRelatedBotsResponseDataBots {
    _id: String
    name: String
    status: BotStatus
    paperContext: Boolean
  }
  type getGlobalVariableRelatedBotsResponseData {
    type: botTypeEnum
    total: Int
    bots: [getGlobalVariableRelatedBotsResponseDataBots]
  }
  type getGlobalVariableRelatedBotsResponse implements BasicResponse {
    status: Status
    reason: String
    data: [getGlobalVariableRelatedBotsResponseData]
  }
  type GlobalVariablesResponse implements BasicResponse {
    status: Status
    reason: String
    data: [GlobalVariables]
    total: Int
  }
  input GetGlobalVariablesInput {
    page: Int
    pageSize: Int
    sortModel: [GridSortItem]
    filterModel: GridFilterModel
  }
  input GetGlobalVariablesByIdsInput {
    ids: [String!]!
  }
  input DeleteGlobalVariableInput {
    id: ID!
  }
  type DeleteGlobalVariableResponse implements BasicResponse {
    status: Status
    reason: String
  }
  input CreateGlobalVariableInput {
    name: String!
    value: String!
    type: GlobalVariableTypeEnum!
  }
  input UpdateGlobalVariableInput {
    id: ID!
    name: String!
    value: String!
    type: GlobalVariableTypeEnum!
  }
  type UpdateGlobalVariableResponse implements BasicResponse {
    status: Status
    reason: String
  }
  type CreateGlobalVariableResponse implements BasicResponse {
    status: Status
    reason: String
    data: GlobalVariables
  }
`

export default [
  BasicSchema,
  UserSchema,
  UserForm,
  UserResponse,
  BotSchema,
  GlobalVariablesSchema,
  AddExchangeInput,
]
