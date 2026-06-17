import { storeToRefs } from 'pinia'
import { useModelStore } from '../../../stores/modelStore.js'
import { createModelService } from './createModelService.js'

export function useModelState() {
  const store = useModelStore()
  return storeToRefs(store)
}

let sharedModelService = null

export default function useModel() {
  if (sharedModelService) return sharedModelService
  sharedModelService = createModelService(storeToRefs(useModelStore()))
  return sharedModelService
}
