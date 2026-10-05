import '@testing-library/jest-dom'

// jsdom (jest-environment-jsdom) no define TextEncoder/TextDecoder, que el
// navegador sí trae y que usa la validación de formularios (bytes UTF-8).
import { TextEncoder, TextDecoder } from 'util'
if (typeof (globalThis as any).TextEncoder === 'undefined') (globalThis as any).TextEncoder = TextEncoder
if (typeof (globalThis as any).TextDecoder === 'undefined') (globalThis as any).TextDecoder = TextDecoder
