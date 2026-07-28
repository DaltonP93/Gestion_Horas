'use client'
import { useParams } from 'next/navigation'
import ModuleLanding from '@/components/layout/ModuleLanding'

// Página principal de cada módulo (tarjetas hacia sus submódulos).
export default function ModulePage() {
  const { group } = useParams<{ group: string }>()
  return <ModuleLanding groupId={String(group)} />
}
