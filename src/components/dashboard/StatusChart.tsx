import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { motion } from 'framer-motion'
import { useExamCards } from '@/hooks/useExamCards'
import { STATUS_CONFIG, CARD_STATUSES } from '@/lib/card-constants'
import { staggerItem } from '@/lib/animations'

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { color: string } }> }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg px-3 py-2 shadow-md text-xs">
      <p className="font-semibold text-[hsl(var(--foreground))]">{payload[0].name}</p>
      <p className="text-[hsl(var(--muted-foreground))]">{payload[0].value} card{payload[0].value !== 1 ? 's' : ''}</p>
    </div>
  )
}

export function StatusChart() {
  const { data: cards } = useExamCards()

  const statusCounts = (cards || []).reduce<Record<string, number>>((acc, card) => {
    acc[card.status] = (acc[card.status] || 0) + 1
    return acc
  }, {})

  const chartData = CARD_STATUSES
    .filter((s) => (statusCounts[s] ?? 0) > 0)
    .map((s) => ({
      name: STATUS_CONFIG[s].label,
      value: statusCounts[s],
      color: STATUS_CONFIG[s].color,
    }))

  const total = chartData.reduce((acc, d) => acc + d.value, 0)

  return (
    <motion.div
      variants={staggerItem}
      className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-sm p-5 h-full"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[hsl(var(--foreground))]">Distribuição por Status</h3>
        {total > 0 && (
          <span className="text-xs text-[hsl(var(--muted-foreground))]">{total} total</span>
        )}
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-[hsl(var(--muted-foreground))] text-sm">
          Sem dados disponíveis
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={80}
              paddingAngle={3}
              dataKey="value"
            >
              {chartData.map((entry, index) => (
                <Cell key={index} fill={entry.color} strokeWidth={0} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend
              iconType="circle"
              iconSize={8}
              formatter={(value) => (
                <span style={{ fontSize: '11px', color: 'hsl(var(--muted-foreground))' }}>{value}</span>
              )}
            />
          </PieChart>
        </ResponsiveContainer>
      )}
    </motion.div>
  )
}
