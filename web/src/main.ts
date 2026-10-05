import { mount } from 'svelte'
import App from './App.svelte'
import { setScript } from './lib/appstate.svelte'
import { parseFunscript } from './lib/funscript'
import './app.css'

const app = mount(App, { target: document.getElementById('app')! })

// dev/demo hook: allows injecting a funscript from the console or a demo harness
;(window as unknown as { __s2v_set: (json: string) => void }).__s2v_set = (json: string) => {
  setScript(parseFunscript(json))
}

export default app
