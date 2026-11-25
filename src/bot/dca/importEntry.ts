/**
 * A terminal "import position" deal adopts a position the user already holds,
 * so its base order is a synthetic FILLED row sized from the user's configured
 * size and entry price (`getSmartSellOrderQty`). Spec `specs/262…`.
 *
 * A size below one quantity step rounds down to 0, and an entry price of 0 on
 * an inverse pair divides by zero (NaN). Neither describes a position: booked,
 * it leaves a deal whose futures average is `0 / 0` and that can never be saved.
 */

/** Whether the import's size and price describe a position that can be booked. §1.3.1 */
export function importEntryUsable(qty: number, price: number): boolean {
  return Number.isFinite(qty) && qty > 0 && Number.isFinite(price) && price > 0
}

/** The bot message that tells the user why the import was refused. §1.3.1 */
export function importEntryRefusalMessage(args: {
  symbol: string
  size: string | number | undefined
  sizeAsset: string
  price: string | number | undefined
  qty: number
}): string {
  const { symbol, size, sizeAsset, price, qty } = args
  return (
    `Cannot import a position on ${symbol}: a size of ${size ?? 0} ${sizeAsset} at a price of ${price ?? 0} ` +
    `gives an order quantity of ${Number.isFinite(qty) ? qty : 'none'}, which is below the smallest quantity this pair accepts. ` +
    `Set the size and average price of the position you hold, then start the deal again`
  )
}

/**
 * Whether an entry row moved anything a position fold should count. A row of 0
 * or NaN changes no position, but dividing by its quantity turns the average
 * into NaN for the deal's whole life. §1.3.3
 */
export function entryQtyMovesPosition(qty: number): boolean {
  return Number.isFinite(qty) && qty > 0
}
