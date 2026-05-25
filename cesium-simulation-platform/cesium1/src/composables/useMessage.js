import { ref } from 'vue'

const message = ref('')
const messageType = ref('success')
const isVisible = ref(false)
let timer = null

export default function useMessage() {
  const show = (msg, type = 'success') => {
    message.value = msg
    messageType.value = type
    isVisible.value = true
    clearTimeout(timer)
    timer = setTimeout(
      () => {
        isVisible.value = false
        message.value = ''
      },
      type === 'error' ? 5000 : 3000
    )
  }

  const hide = () => {
    isVisible.value = false
    message.value = ''
    clearTimeout(timer)
  }
  return {
    message,
    messageType,
    isVisible,
    showMessage: show,
    showOperationMessage: show,
    hideMessage: hide
  }
}
