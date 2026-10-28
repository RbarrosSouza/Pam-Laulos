import {useIntakePanel} from '@/hooks/useIntakePanel'
import {HomeIntakeIssuesView} from './HomeIntakeIssuesView'
export function HomeIntakeIssues(){
  const query=useIntakePanel()
  return <HomeIntakeIssuesView data={query.data} loading={query.isPending} error={query.isError} refreshing={query.isFetching} now={query.now} paused={query.snapshotPaused} onRefresh={()=>void query.refetch()}/>
}
