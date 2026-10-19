export type ShipmentHistoryFilter = 'today' | 'week' | 'all'

const clinicTimeZone = 'America/Sao_Paulo'
const calendarFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: clinicTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
})
const clockFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: clinicTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** The clinic's calendar day must not depend on the browser's timezone. */
export function shipmentCalendarDate(date: Date): string {
  const parts = calendarFormatter.formatToParts(date)
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-')
}

function shiftDate(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function clinicMidnight(day: string): string {
  const desired = Date.parse(`${day}T00:00:00Z`)
  let timestamp = desired
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = clockFormatter.formatToParts(new Date(timestamp))
    const value = (key: string) => Number(parts.find(part => part.type === key)?.value)
    const observed = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
    const difference = desired - observed
    timestamp += difference
    if (!difference) break
  }
  return new Date(timestamp).toISOString()
}

/** UTC bounds for seven clinic calendar dates including today, with an exclusive end. */
export function getShipmentDateFilters(filter: ShipmentHistoryFilter, today: string): { startAt?: string; endBefore?: string } {
  if (filter === 'all') return {}
  return {
    startAt: clinicMidnight(filter === 'week' ? shiftDate(today, -6) : today),
    endBefore: clinicMidnight(shiftDate(today, 1)),
  }
}
