export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const pitchClass = (midi) => ((midi % 12) + 12) % 12;
export const midiToName = (midi) => NOTE_NAMES[pitchClass(midi)] + (Math.floor(midi / 12) - 1);
export const midiToFreq = (midi, a4 = 440) => a4 * 2 ** ((midi - 69) / 12);
export const freqToMidi = (freq, a4 = 440) => 69 + 12 * Math.log2(freq / a4);

// Standard re-entrant tuning, G string first (as chord diagrams are written).
export const UKE_TUNING = [67, 60, 64, 69];
