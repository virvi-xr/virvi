'use client'
// Sends the visitor to the BEAT landing page (/beat), keeping a plain link for the moment before it does.
import { useEffect } from 'react'

export const BEAT_LANDING = '/beat/'

export function GoToBeat() {
  useEffect(() => { window.location.replace(BEAT_LANDING) }, [])
  return <p className="p-6 text-sm text-gray-400"><a href={BEAT_LANDING} className="underline">Go to the BEAT page</a></p>
}
