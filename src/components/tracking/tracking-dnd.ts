import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core'

/** CSS hides alternate layouts. Hidden targets must never receive a move. */
export const trackingCollisionDetection: CollisionDetection = args => {
  const visibleArgs = { ...args, droppableContainers: args.droppableContainers.filter(container => {
    const rect = args.droppableRects.get(container.id)
    return rect && rect.width > 0 && rect.height > 0
  }) }
  // A card's handle can be far from its center. On mobile, honor the stage
  // under the pointer rather than the center of the whole card.
  const stage = pointerWithin(visibleArgs).find(hit => String(hit.id).startsWith('stage-'))
  return stage ? [stage] : closestCenter(visibleArgs)
}
