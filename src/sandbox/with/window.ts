import type {
  microAppWindowType,
  CommonEffectHook,
  MicroEventListener,
  timeInfo,
  WithSandBoxInterface,
} from '@micro-app/types'
import type {
  proxyWindow
} from './index'
import globalEnv from '../../libs/global_env'
import bindFunctionToRawTarget from '../bind_function'
import {
  SCOPE_WINDOW_EVENT,
} from '../../constants'
import {
  isString,
  unique,
  throttleDeferForSetAppName,
  rawDefineProperty,
  rawHasOwnProperty,
} from '../../libs/utils'

// create proxyWindow with Proxy(microAppWindow)
export function createProxyWindow (
  appName: string,
  microAppWindow: microAppWindowType,
  sandbox: WithSandBoxInterface,
): proxyWindow {
  const rawWindow = globalEnv.rawWindow
  const descriptorTargetMap = new Map<PropertyKey, 'target' | 'rawWindow'>()
  return new Proxy(microAppWindow, {
    get: (target: microAppWindowType, key: PropertyKey): unknown => {
      throttleDeferForSetAppName(appName)
      if (
        Reflect.has(target, key) ||
        (isString(key) && /^__MICRO_APP_/.test(key)) ||
        sandbox.scopeProperties.includes(key)
      ) return Reflect.get(target, key)

      return bindFunctionToRawTarget(Reflect.get(rawWindow, key), rawWindow)
    },
    set: (target: microAppWindowType, key: PropertyKey, value: unknown): boolean => {
      /**
       * TODO:
       * 1、location域名相同，子应用内部跳转时的处理
       */
      if (sandbox.adapter.escapeSetterKeyList.includes(key)) {
        Reflect.set(rawWindow, key, value)
      } else if (
        // target.hasOwnProperty has been rewritten
        !rawHasOwnProperty.call(target, key) &&
        rawHasOwnProperty.call(rawWindow, key) &&
        !sandbox.scopeProperties.includes(key)
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, key)
        const { configurable, enumerable, writable, set } = descriptor!
        // set value because it can be set
        rawDefineProperty(target, key, {
          value,
          configurable,
          enumerable,
          writable: writable ?? !!set,
        })

        sandbox.injectedKeys.add(key)
      } else {
        !Reflect.has(target, key) && sandbox.injectedKeys.add(key)
        Reflect.set(target, key, value)
      }

      if (
        (
          sandbox.escapeProperties.includes(key) ||
          (
            sandbox.adapter.staticEscapeProperties.includes(key) &&
            !Reflect.has(rawWindow, key)
          )
        ) &&
        !sandbox.scopeProperties.includes(key)
      ) {
        !Reflect.has(rawWindow, key) && sandbox.escapeKeys.add(key)
        Reflect.set(rawWindow, key, value)
      }

      return true
    },
    has: (target: microAppWindowType, key: PropertyKey): boolean => {
      if (sandbox.scopeProperties.includes(key)) {
        /**
         * Some keywords, such as Vue, need to meet two conditions at the same time:
         * 1. 'Vue' in window --> false
         * 2. Vue (top level variable) // undefined
         * Issue https://github.com/micro-zoe/micro-app/issues/686
         */
        if (sandbox.adapter.staticScopeProperties.includes(key)) {
          return !!target[key]
        }
        return key in target
      }
      return key in target || key in rawWindow
    },
    // Object.getOwnPropertyDescriptor(window, key)
    getOwnPropertyDescriptor: (target: microAppWindowType, key: PropertyKey): PropertyDescriptor|undefined => {
      if (rawHasOwnProperty.call(target, key)) {
        descriptorTargetMap.set(key, 'target')
        return Object.getOwnPropertyDescriptor(target, key)
      }

      if (rawHasOwnProperty.call(rawWindow, key)) {
        descriptorTargetMap.set(key, 'rawWindow')
        const descriptor = Object.getOwnPropertyDescriptor(rawWindow, key)
        if (descriptor && !descriptor.configurable) {
          descriptor.configurable = true
        }
        return descriptor
      }

      return undefined
    },
    // Object.defineProperty(window, key, Descriptor)
    defineProperty: (target: microAppWindowType, key: PropertyKey, value: PropertyDescriptor): boolean => {
      const from = descriptorTargetMap.get(key)
      if (from === 'rawWindow') {
        return Reflect.defineProperty(rawWindow, key, value)
      }
      return Reflect.defineProperty(target, key, value)
    },
    // Object.getOwnPropertyNames(window)
    ownKeys: (target: microAppWindowType): Array<string | symbol> => {
      return unique(Reflect.ownKeys(rawWindow).concat(Reflect.ownKeys(target)))
    },
    deleteProperty: (target: microAppWindowType, key: PropertyKey): boolean => {
      if (rawHasOwnProperty.call(target, key)) {
        sandbox.injectedKeys.has(key) && sandbox.injectedKeys.delete(key)
        sandbox.escapeKeys.has(key) && Reflect.deleteProperty(rawWindow, key)
        return Reflect.deleteProperty(target, key)
      }
      return true
    },
  })
}

/**
 * Rewrite side-effect events
 * @param microAppWindow micro window
 */
export function patchWindowEffect (
  appName: string,
  microAppWindow: microAppWindowType,
): CommonEffectHook {
  const eventListenerMap = new Map<string, Set<MicroEventListener>>()
  const sstEventListenerMap = new Map<string, Set<MicroEventListener>>()
  const intervalIdMap = new Map<number, timeInfo>()
  const timeoutIdMap = new Map<number, timeInfo>()
  const {
    rawWindow,
    rawAddEventListener,
    rawRemoveEventListener,
    rawDispatchEvent,
    rawSetInterval,
    rawSetTimeout,
    rawClearInterval,
    rawClearTimeout,
  } = globalEnv

  function getEventTarget (type: string): Window {
    return SCOPE_WINDOW_EVENT.includes(type) ? microAppWindow : rawWindow
  }

  /**
   * listener may be null, e.g test-passive
   * TODO:
   *  1. listener 是否需要绑定microAppWindow，否则函数中的this指向原生window
   *  2. 如果this不指向proxyWindow 或 microAppWindow，应该要做处理
   *  window.addEventListener.call(非window, type, listener, options)
   */
  microAppWindow.addEventListener = function (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // console.log(3333333, this)
    const listenerList = eventListenerMap.get(type)
    if (listenerList) {
      listenerList.add(listener)
    } else {
      eventListenerMap.set(type, new Set([listener]))
    }
    listener && (listener.__MICRO_APP_MARK_OPTIONS__ = options)
    rawAddEventListener.call(getEventTarget(type), type, listener, options)
  }

  microAppWindow.removeEventListener = function (
    type: string,
    listener: MicroEventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const listenerList = eventListenerMap.get(type)
    if (listenerList?.size && listenerList.has(listener)) {
      listenerList.delete(listener)
    }
    rawRemoveEventListener.call(getEventTarget(type), type, listener, options)
  }

  microAppWindow.dispatchEvent = function (event: Event): boolean {
    return rawDispatchEvent.call(getEventTarget(event?.type), event)
  }

  microAppWindow.setInterval = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ): number {
    const intervalId = rawSetInterval.call(rawWindow, handler, timeout, ...args)
    intervalIdMap.set(intervalId, { handler, timeout, args })
    return intervalId
  }

  microAppWindow.setTimeout = function (
    handler: TimerHandler,
    timeout?: number,
    ...args: any[]
  ): number {
    const timeoutId = rawSetTimeout.call(rawWindow, handler, timeout, ...args)
    timeoutIdMap.set(timeoutId, { handler, timeout, args })
    return timeoutId
  }

  microAppWindow.clearInterval = function (intervalId: number) {
    intervalIdMap.delete(intervalId)
    rawClearInterval.call(rawWindow, intervalId)
  }

  microAppWindow.clearTimeout = function (timeoutId: number) {
    timeoutIdMap.delete(timeoutId)
    rawClearTimeout.call(rawWindow, timeoutId)
  }

  // reset snapshot data
  const reset = (): void => {
    sstEventListenerMap.clear()
  }

  /**
   * NOTE:
   *  1. about timer(events & properties should record & rebuild at all modes, exclude default mode)
   *  2. record maybe call twice when unmount prerender, keep-alive app manually with umd mode
   * 4 modes: default-mode、umd-mode、prerender、keep-alive
   * Solution:
   *  1. default-mode(normal): clear events & timers, not record & rebuild anything
   *  2. umd-mode(normal): not clear timers, record & rebuild events
   *  3. prerender/keep-alive(default, umd): not clear timers, record & rebuild events
   */
  const record = (): void => {
    // record window event
    eventListenerMap.forEach((listenerList, type) => {
      if (listenerList.size) {
        const cacheList = sstEventListenerMap.get(type) || []
        sstEventListenerMap.set(type, new Set([...cacheList, ...listenerList]))
      }
    })
  }

  // rebuild event and timer before remount app
  const rebuild = (): void => {
    // rebuild window event
    sstEventListenerMap.forEach((listenerList, type) => {
      for (const listener of listenerList) {
        microAppWindow.addEventListener(type, listener, listener?.__MICRO_APP_MARK_OPTIONS__)
      }
    })

    reset()
  }

  // release all event listener & interval & timeout when unmount app
  const release = (clearTimer: boolean): void => {
    // Clear window binding events
    if (eventListenerMap.size) {
      eventListenerMap.forEach((listenerList, type) => {
        for (const listener of listenerList) {
          rawRemoveEventListener.call(getEventTarget(type), type, listener)
        }
      })
      eventListenerMap.clear()
    }

    // default mode(not keep-alive or isPrerender)
    if (clearTimer) {
      intervalIdMap.forEach((_, intervalId: number) => {
        rawClearInterval.call(rawWindow, intervalId)
      })

      timeoutIdMap.forEach((_, timeoutId: number) => {
        rawClearTimeout.call(rawWindow, timeoutId)
      })

      intervalIdMap.clear()
      timeoutIdMap.clear()
    }
  }

  return {
    reset,
    record,
    rebuild,
    release,
  }
}
