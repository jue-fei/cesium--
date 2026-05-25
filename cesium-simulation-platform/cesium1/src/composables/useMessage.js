import { ref } from 'vue'

const message = ref('')
const messageType = ref('success')
const isVisible = ref(false)
let messageTimer = null

const MESSAGE_DISPLAY_TIMES = {
  ERROR: 5000,
  DEFAULT: 3000
}

export default function useMessage() {
  const showMessage = (msg, type = 'success') => {
    message.value = msg
    messageType.value = type
    isVisible.value = true

    if (messageTimer) clearTimeout(messageTimer)

    const duration = type === 'error' ? MESSAGE_DISPLAY_TIMES.ERROR : MESSAGE_DISPLAY_TIMES.DEFAULT

    messageTimer = setTimeout(() => {
      isVisible.value = false
      message.value = ''
    }, duration)
  }

  const hideMessage = () => {
    isVisible.value = false
    message.value = ''
    if (messageTimer) clearTimeout(messageTimer)
  }

  return {
    message,
    messageType,
    isVisible,
    showMessage,
    showOperationMessage: showMessage,
    hideMessage
  }
}
