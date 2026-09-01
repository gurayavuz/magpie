import { listen } from '@/lib/protocol'
import { captureHandlers } from './capture'
import { clipperHandlers } from './clipper'
import { recorderControlHandlers } from './recorder-control'
import { countdownHandlers } from './countdown'

listen({
  ...captureHandlers,
  ...clipperHandlers,
  ...recorderControlHandlers,
  ...countdownHandlers,
})
