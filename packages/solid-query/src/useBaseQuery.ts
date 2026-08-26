// Had to disable the lint rule because isServer type is defined as false
// in solid-js/web package. I'll create a GitHub issue with them to see
// why that happens.
import { notifyManager, shouldThrowError } from '@tanstack/query-core'
import {
  createRenderEffect,
  flush,
  createSignal,
  createStore,
  getObserver,
  isPending,
  onCleanup,
  reconcile,
  refresh,
  runWithOwner,
  sharedConfig,
  snapshot,
  untrack,
  useContext,
} from 'solid-js'
import { useQueryClient } from './QueryClientProvider'
import { HydrationCoordinatorContext } from './hydrationChannel'
import { useIsRestoring } from './isRestoring'
import type { UseBaseQueryOptions } from './types'
import type { Accessor } from 'solid-js'
import type { QueryClient } from './QueryClient'
import type {
  Query,
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'

const isServer = typeof window === 'undefined'

/**
 * During SSR, Solid's store is serialized by seroval which cannot handle
 * functions.  Strip `refetch`, `fetchNextPage`, and `fetchPreviousPage`
 * from the observer result before it enters the store so serialization
 * succeeds.  On the client this is a no-op (returns the object as-is).
 */
function _stripFnsForSSR<TData, TError>(
  obj: QueryObserverResult<TData, TError>,
): QueryObserverResult<TData, TError> {
  if (!isServer) return obj
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) {
    if (k === 'refetch' || k === 'fetchNextPage' || k === 'fetchPreviousPage') {
      out[k] = undefined
    } else {
      out[k] = (obj as any)[k]
    }
  }
  return out as unknown as QueryObserverResult<TData, TError>
}

function reconcileFn<TData, TError>(
  store: QueryObserverResult<TData, TError>,
  result: QueryObserverResult<TData, TError>,
  reconcileOption:
    | string
    | false
    | ((oldData: TData | undefined, newData: TData) => TData),
  queryHash?: string,
): QueryObserverResult<TData, TError> {
  if (typeof reconcileOption === 'function') {
    const newData = reconcileOption(store.data, result.data as TData)
    return { ...result, data: newData } as typeof result
  }

  if (reconcileOption === false) return result

  const key = reconcileOption

  let data = result.data
  if (store.data === undefined) {
    try {
      data = structuredClone(data)
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        if (error instanceof Error) {
          console.warn(
            `Unable to correctly reconcile data for query key: ${queryHash}. ` +
              `Possibly because the query data contains data structures that aren't supported ` +
              `by the 'structuredClone' algorithm. Consider using a callback function instead ` +
              `to manage the reconciliation manually.\n\n Error Received: ${error.name} - ${error.message}`,
          )
        }
      }
    }
  }
  // reconcile() in Solid 2.0 mutates in place and returns void.
  // We apply it to store.data so the store's nested signals update.
  // On first load (store.data is undefined), there's nothing to reconcile against,
  // so we just return the data as-is.
  if (store.data !== undefined && data !== undefined) {
    reconcile(data, key)(store.data)
    // Return result with the existing store.data reference (now reconciled in place)
    return { ...result, data: store.data } as typeof result
  }
  return { ...result, data } as typeof result
}

/**
 * Prepare an observer result for SSR serialization: the resolved resource
 * value is serialized by seroval, which cannot handle functions, so strip
 * `refetch` (and the infinite-query pagers). They come back when the
 * observer attaches on the client.
 *
 * The query's dehydrated cache state does not ride the observer result —
 * it travels through the provider-owned dehydration channel (see
 * `hydrationChannel.ts`).
 */
const hydratableObserverResult = <
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
  TDataHydratable,
>(
  _query: Query<TQueryFnData, TError, TData, TQueryKey>,
  result: QueryObserverResult<TDataHydratable, TError>,
) => {
  if (!isServer) return result
  const obj: any = {
    ...snapshot(result),
    // During SSR, functions cannot be serialized, so we need to remove them
    // This is safe because we will add these functions back when the query is hydrated
    refetch: undefined,
  }

  // If the query is an infinite query, we need to remove additional properties
  if ('fetchNextPage' in result) {
    obj.fetchNextPage = undefined
    obj.fetchPreviousPage = undefined
  }

  return obj
}

// Base Query Function that is used to create the query.
export function useBaseQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  options: Accessor<
    UseBaseQueryOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>
  >,
  Observer: typeof QueryObserver,
  queryClient?: Accessor<QueryClient>,
) {
  type ResourceData = QueryObserverResult<TData, TError>

  // Use createSignal(fn) instead of createMemo so these derived memos have
  // _preventAutoDisposal set. Without it, a createMemo that no one reads
  // reactively gets auto-disposed in Solid v2, which cascades and disposes
  // the component's onCleanup, unsubscribing the observer before the fetch
  // completes.
  const [client] = createSignal(() => useQueryClient(queryClient?.()))
  const isRestoring = useIsRestoring()
  // There are times when we run a query on the server but the resource is never read
  // This could lead to times when the queryObserver is unsubscribed before the resource has loaded
  // Causing a time out error. To prevent this we will queue the unsubscribe if the cleanup is called
  // before the resource has loaded
  let unsubscribeQueued = false

  const [defaultedOptions] = createSignal(() => {
    const defaultOptions = client().defaultQueryOptions(options())
    defaultOptions._optimisticResults = isRestoring()
      ? 'isRestoring'
      : 'optimistic'
    defaultOptions.structuralSharing = false
    if (isServer) {
      defaultOptions.retry = false
      defaultOptions.throwOnError = true
      // Enable prefetch during render for SSR - required for createResource to work
      // Without this, queries wait for effects which never run on the server
      defaultOptions.experimental_prefetchInRender = true
    }
    return defaultOptions
  })

  const observer = untrack(() => new Observer(client(), defaultedOptions()))

  // Track options reactively so the queryResource memo re-runs on change.
  const [trackedDefaultedOptions] = createSignal(() => defaultedOptions())

  // Apply options in an effect to avoid store writes inside the memo.
  // setOptions triggers updateResult → notify → subscription → setState,
  // which must run in an effect context in Solid v2.
  //
  // The suspense gate below also applies options, during propagation —
  // needed because this effect's commit is deferred while suspended reads
  // keep the subtree pending. The shared `appliedOptions` marker keeps the
  // two from double-applying, and the stale-flush guard keeps a deferred
  // commit of this effect (which can carry a superseded value after the
  // subtree settles) from flipping the observer back to the old query.
  createRenderEffect(
    () => trackedDefaultedOptions(),
    (opts) => {
      // observer.setOptions synchronously invokes subscribers which write to
      // the store. In Solid v2, signal/store writes inside an owned scope
      // (like this render effect) throw. Escape the owner so subscriber
      // writes don't trip the guard.
      runWithOwner(null, () => observer.setOptions(opts))
    },
  )

  let observerResult = untrack(() =>
    observer.getOptimisticResult(defaultedOptions()),
  )

  const [state, setState] = createStore<QueryObserverResult<TData, TError>>(
    _stripFnsForSSR(observerResult),
  )

  const createServerSubscriber = (
    resolve: (
      data: ResourceData | PromiseLike<ResourceData | undefined> | undefined,
    ) => void,
    reject: (reason?: any) => void,
  ) => {
    return observer.subscribe((result) => {
      notifyManager.batchCalls(() => {
        const query = observer.getCurrentQuery()
        const unwrappedResult = hydratableObserverResult(query, result)

        if (result.data !== undefined && unwrappedResult.isError) {
          reject(unwrappedResult.error)
          unsubscribeIfQueued()
        } else {
          resolve(unwrappedResult)
          unsubscribeIfQueued()
        }
      })()
    })
  }

  const unsubscribeIfQueued = () => {
    if (unsubscribeQueued) {
      unsubscribe?.()
      unsubscribeQueued = false
    }
  }

  const createClientSubscriber = () => {
    return observer.subscribe((result) => {
      const previousResult = observerResult
      observerResult = result
      runWithOwner(null, () => {
        setStateWithReconciliation(result)
        if (
          unsubscribe &&
          !disposed &&
          (previousResult.isLoading !== result.isLoading ||
            previousResult.isError !== result.isError)
        ) {
          try {
            refresh(queryResource)
          } catch {
            // NotReadyError is expected when refreshing a memo that returns
            // a Promise. The Loading boundary handles this during rendering.
          }
        }
      })
    })
  }

  function setStateWithReconciliation(res: typeof observerResult) {
    const opts = observer.options
    const reconcileOptions = (opts as any).reconcile
    const sanitized = _stripFnsForSSR(res)

    setState((store) => {
      return reconcileFn(
        store,
        sanitized,
        reconcileOptions === undefined ? false : reconcileOptions,
        opts.queryHash,
      )
    })
  }

  /**
   * Unsubscribe is set lazily, so that we can subscribe after hydration when needed.
   */
  let unsubscribe: (() => void) | null = null
  let disposed = false

  /**
   * Attach the client subscriber for a component that hydrated from SSR
   * output.
   *
   * During hydration Solid replays the `queryResource` memo below from the
   * serialized SSR value with `Promise` mocked, so the promise executor
   * that normally creates the client subscriber never runs (nor could it:
   * a mount refetch started from inside the replay would never settle).
   * The replay is detected without touching any internals: a real
   * `Promise` runs its executor synchronously, the hydration mock does
   * not, so `executorRan` stays false exactly when this compute was
   * replayed.
   *
   * The subscription is coordinated with the provider's dehydration
   * channel: it attaches once this query's entry has been primed into the
   * cache (or once the channel completes without one), so mount semantics
   * see the hydrated cache state — a still-fresh query does not refetch, a
   * stale one does, and cache writes that landed earlier are reconciled at
   * attach. The wait is per-query, not global-hydration-end: a component
   * hydrated from an early flush goes live while later boundaries are
   * still streaming, so it is not deaf to cache writes, is seen by
   * invalidateQueries' active-query refetch, and cannot be gc'ed while
   * visible. Without a provider (manual `queryClient` option) it falls
   * back to a plain microtask.
   */
  const coordinator = useContext(HydrationCoordinatorContext)
  const attachHydratedSubscriber = () => {
    if (!unsubscribe && !disposed && !isRestoring()) {
      unsubscribe = createClientSubscriber()
    }
  }
  const scheduleHydratedAttach = () => {
    const queryHash = untrack(() => observer.getCurrentQuery().queryHash)
    if (coordinator) {
      coordinator.whenQueryPrimed(queryHash, attachHydratedSubscriber)
    } else {
      queueMicrotask(attachHydratedSubscriber)
    }
  }

  /*
    Fixes #7275
    In a few cases, the observer could unmount before the resource is loaded.
    This leads to Suspense boundaries to be suspended indefinitely.
    This resolver will be called when the observer is unmounting
    but the resource is still in a loading state
  */
  /**
   * Client-side suspense gate for non-nullable `data` reads. While the
   * current query is loading, the gate's value is a live thenable that
   * settles exactly when the query's fetch does. Reading the gate from a
   * tracking scope while that promise is pending throws a properly-sourced
   * NotReadyError (the runtime attaches this node as the not-ready
   * source), parking the reader until the fetch lands; the settle then
   * wakes the parked readers, which re-read the store once the deferred
   * options effect has synced it. Once settled (or when nothing is
   * loading) the gate yields nothing and reads fall through to the store.
   */
  const [suspenseGate] = createSignal<unknown>(() => {
    const opts = trackedDefaultedOptions()
    if (isServer) return undefined
    const result = untrack(() => observer.getOptimisticResult(opts))
    if (!result.isLoading) return undefined
    // A live thenable that settles when the query for these options
    // settles, watched through the query cache — agnostic to who runs the
    // fetch (the observer's option-change fetch in the render effect, a
    // router loader's prefetch, or the gate's own kick below). The gate
    // starts a fetch itself only when nobody else has after a microtask:
    // in normal flows the render effect's setOptions triggers the fetch
    // synchronously within the flush, but while suspended reads keep this
    // subtree pending Solid defers that effect's commit — precisely the
    // case where the fetch must be kicked from here (via the observer's
    // optimistic-fetch path, carrying the observer's behavior so infinite
    // queries fetch page-shaped data). It never rejects — errors surface
    // through the query state (and throwOnError), not through the gate.
    return new Promise<void>((resolve) => {
      const queryCache = untrack(() => client().getQueryCache())
      const queryHash = opts.queryHash as string
      let done = false
      const finish = () => {
        if (done) return
        done = true
        unsubscribeGate()
        resolve()
      }
      const isSettled = () => {
        const query = queryCache.get(queryHash)
        return query !== undefined && query.state.status !== 'pending'
      }
      const unsubscribeGate = queryCache.subscribe(() => {
        if (isSettled()) finish()
      })
      onCleanup(finish)
      queueMicrotask(() => {
        if (done) return
        // Give a *scheduled* options render effect its chance to commit and
        // start the fetch first — flush() runs scheduled work but leaves
        // commits deferred by a pending subtree alone, which is exactly
        // the case the kick below exists for.
        flush()
        if (done) return
        if (isSettled()) return finish()
        const query = queryCache.get(queryHash)
        if (!query || query.state.fetchStatus === 'idle') {
          const behavior = untrack(() => observer.options as any)?.behavior
          void untrack(() =>
            observer.fetchOptimistic(
              behavior ? ({ ...opts, behavior } as typeof opts) : opts,
            ),
          ).catch(() => {})
        }
      })
    })
  })

  let resolver: ((value: ResourceData) => void) | null = null
  // Use createSignal(fn) instead of createMemo so the derived memo has
  // _preventAutoDisposal set. Without it, a createMemo that no one reads
  // reactively gets auto-disposed in Solid v2, which would cascade-dispose
  // the component's onCleanup and unsubscribe the observer before fetch
  // completion.
  const [queryResource] = createSignal<ResourceData>(() => {
    // Read trackedDefaultedOptions to ensure this memo re-runs when options change
    const opts = trackedDefaultedOptions()
    // Read isRestoring unconditionally so the memo re-runs when it changes
    const restoring = isRestoring()

    if (isServer) {
      // On retry passes (after the streaming Loading boundary awaits a
      // pending Promise), the QueryClient cache already has the data, so
      // `getOptimisticResult` returns a non-loading result synchronously.
      // Returning the value directly (instead of a fresh Promise that
      // resolves synchronously) lets Solid's `processResult` set
      // `comp.value` directly without queueing another async settle. If we
      // returned a new Promise on every retry, Solid's streaming Loading
      // boundary `while (ret.p.length)` loop in `createLoadingBoundary`
      // would never terminate, because each retry adds a new pending
      // Promise to the boundary's tracked set even when it resolves
      // synchronously.
      const cached = observer.getOptimisticResult(opts)
      if (!cached.isLoading) {
        observerResult = cached
        runWithOwner(null, () => {
          setStateWithReconciliation(cached)
        })
        return hydratableObserverResult(
          observer.getCurrentQuery(),
          cached,
        ) as ResourceData
      }
    }

    const replayProbe = { executorRan: false }
    const resource = new Promise<ResourceData>((resolve, reject) => {
      replayProbe.executorRan = true
      resolver = resolve
      if (isServer) {
        unsubscribe = createServerSubscriber((data) => {
          resolve(data as ResourceData)
        }, reject)
      } else if (!unsubscribe && !restoring) {
        unsubscribe = createClientSubscriber()
      }
      // Use getOptimisticResult instead of updateResult to keep the memo
      // free of store writes (updateResult triggers notify → setState).
      const currentResult = observer.getOptimisticResult(opts)
      observerResult = currentResult

      // Store writes inside a memo's owned scope throw in Solid v2.
      // Escape the owner so setState calls are allowed.
      runWithOwner(null, () => {
        if (
          currentResult.isError &&
          !currentResult.isFetching &&
          !restoring &&
          shouldThrowError(opts.throwOnError, [
            currentResult.error,
            observer.getCurrentQuery(),
          ])
        ) {
          setStateWithReconciliation(currentResult)
          reject(currentResult.error)
          return
        }
        setStateWithReconciliation(currentResult)
      })

      if (
        currentResult.isError &&
        !currentResult.isFetching &&
        !restoring &&
        shouldThrowError(opts.throwOnError, [
          currentResult.error,
          observer.getCurrentQuery(),
        ])
      ) {
        return
      }
      if (!currentResult.isLoading) {
        resolver = null
        return resolve(
          hydratableObserverResult(observer.getCurrentQuery(), currentResult),
        )
      }
    })

    if (!isServer && !replayProbe.executorRan) {
      // Hydration replay: `Promise` was mocked and the executor above never
      // ran, so no subscriber was created. Schedule the attach through the
      // provider's hydration coordinator (see scheduleHydratedAttach).
      scheduleHydratedAttach()
    }

    return resource
  })

  onCleanup(() => {
    disposed = true
    if (isServer && isPending(queryResource)) {
      unsubscribeQueued = true
      return
    }
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    if (resolver && !isServer) {
      resolver(observerResult)
      resolver = null
    }
  })

  // Properties that should never throw — these let users access error info
  // even outside an ErrorBoundary.
  const errorPassthroughProps = new Set([
    'error',
    'isError',
    'failureCount',
    'failureReason',
    'errorUpdateCount',
    'errorUpdatedAt',
  ])

  // Return a proxy that throws on property access when throwOnError is enabled
  return new Proxy(state, {
    get(target, prop, receiver) {
      // Always pass through symbols (needed for store internals, iteration, etc.)
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }

      // On the server, force a Suspense dependency on the query resource so
      // the per-route Loading boundary catches NotReadyError, awaits the
      // pending Promise, and re-renders with the resolved state. Without
      // this, JSX reads through the Proxy never subscribe to queryResource
      // and SSR HTML reflects the initial loading state.
      //
      // Read the value from the *resolved resource* rather than `state`. When
      // the boundary suspends and re-renders after the query settles, the
      // `state` store is not synced (the server subscriber resolves the
      // resource Promise but does not write the store), so reading `state`
      // would render stale loading values. Reading the resolved resource keeps
      // the streamed SSR HTML consistent with the serialized resource, which
      // is what the client hydrates against.
      if (isServer) {
        const resolved = queryResource()
        if (prop in resolved) {
          return Reflect.get(resolved, prop)
        }
      }

      // Always pass through error-related props without throwing
      if (errorPassthroughProps.has(prop)) {
        return Reflect.get(target, prop, receiver)
      }

      // Check throwOnError condition before returning the value
      if (
        state.isError &&
        !state.isFetching &&
        shouldThrowError(observer.options.throwOnError, [
          state.error,
          observer.getCurrentQuery(),
        ])
      ) {
        throw state.error
      }

      // `data` is typed non-nullable, so a read that happens before the first
      // fetch settles has no value to return. Suspend instead, by reading
      // the pending query resource: the read throws a properly-sourced
      // NotReadyError (the runtime attaches the resource memo as the
      // not-ready source, which is what boundaries and the settle sweep
      // track — a hand-thrown NotReadyError carrying a non-reactive source
      // corrupts that tracking). It mirrors the isServer branch above so
      // both sides behave the same, and falls through when the resource
      // settled between the store update and this read.
      //
      // Only `isLoading` suspends (pending *and* fetching). A query that is
      // pending but idle — disabled, or reset with no observer fetching — has
      // nothing in flight to wait for, so it yields undefined rather than
      // parking the boundary on a promise that never resolves.
      //
      // Untracked reads pass through: event handlers and effect callbacks
      // peek at the raw value, which keeps imperative access working (and
      // lets callers observe pending states) without suspending.
      //
      // Hydration stands down: while Solid is claiming server-rendered DOM
      // (`sharedConfig.hydrating`), a suspension here would bail the claim
      // — the server rendered this content from settled data the streaming
      // channel has not yet primed on the client — leaving unclaimed nodes
      // and an unsettleable boundary. Reads during that window return the
      // store value, exactly as before data became non-nullable.
      if (
        prop === 'data' &&
        getObserver() &&
        state.status === 'pending' &&
        !sharedConfig.hydrating
      ) {
        suspenseGate()
        // The gate has settled but the subscriber may not have synced the
        // store yet (the gate's fetch promise can resolve ahead of the
        // observer notification). Serve this read from the observer's
        // fresh result; the store sync follows and re-renders. The store
        // reads above keep this reader subscribed either way.
        const fresh = untrack(() =>
          observer.getOptimisticResult(
            untrack(() => trackedDefaultedOptions()),
          ),
        )
        if (fresh.status !== 'pending') {
          return Reflect.get(fresh, prop)
        }
      }

      return Reflect.get(target, prop, receiver)
    },
  })
}
