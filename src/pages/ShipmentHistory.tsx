import { useMemo, useState } from 'react'
import { ShipmentHistoryView } from '@/components/samples/ShipmentHistoryView'
import { getShipmentDateFilters, shipmentCalendarDate, type ShipmentHistoryFilter } from '@/components/samples/shipment-history-period'
import { useShipmentHistory } from '@/hooks/useShipment'

export function ShipmentHistory() {
  const [filter, setFilter] = useState<ShipmentHistoryFilter>('today')
  const today = shipmentCalendarDate(new Date())
  const filters = useMemo(() => getShipmentDateFilters(filter, today), [filter, today])
  const query = useShipmentHistory(filters)

  return <ShipmentHistoryView
    shipments={query.data || []}
    loading={query.isLoading}
    error={query.error}
    refreshing={query.isFetching}
    onRefresh={() => { void query.refetch() }}
    filter={filter}
    onFilterChange={setFilter}
  />
}
