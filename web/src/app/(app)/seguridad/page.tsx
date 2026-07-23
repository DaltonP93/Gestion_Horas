import { redirect } from 'next/navigation'

// La seguridad personal se movió al menú de cuenta → "Seguridad de mi cuenta".
// Se conserva esta ruta como redirección para no romper enlaces existentes.
export default function SeguridadRedirect() {
  redirect('/cuenta/seguridad')
}
