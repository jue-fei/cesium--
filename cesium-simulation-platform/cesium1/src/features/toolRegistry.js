import { TOOL_REGISTRY_META, resolveToolLoader } from '@/config/constants/toolRegistryMeta.js'
import { onConfigLoaded } from '@/services/api/initApiConfig.js'

export const TOOL_REGISTRY = TOOL_REGISTRY_META.map(({ id, name, icon }) => ({
  id,
  name,
  icon,
  loader: resolveToolLoader(id)
}))

export function getApiToolRegistry() {
  return TOOL_REGISTRY
}

export function onToolsReady(fn) {
  onConfigLoaded(() => {
    fn(getApiToolRegistry())
  })
}
