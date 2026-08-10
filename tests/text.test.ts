import { describe, expect, it } from 'vitest';
import { findBestMatch, flatten, normalize } from '../src/utils/text.js';

describe('normalize', () => {
  it('ignora mayúsculas y tildes', () => {
    expect(normalize('Videoatención')).toBe('videoatencion');
    expect(normalize('BOGOTÁ, D.C.')).toBe('bogota, d.c');
  });

  it('descarta el punto final', () => {
    expect(normalize('Devoluciones.')).toBe(normalize('Devoluciones'));
    expect(normalize('Cobranzas.')).toBe('cobranzas');
  });

  it('colapsa los espacios', () => {
    expect(normalize('  Persona   Natural  ')).toBe('persona natural');
  });
});

describe('flatten', () => {
  it('convierte los saltos de línea del <br> en espacios', () => {
    expect(flatten('Persona\nNatural')).toBe('Persona Natural');
  });
});

describe('findBestMatch', () => {
  const options = [
    { key: '1', label: 'RUT y orientación TAC.' },
    { key: '2', label: 'Conferencias o capacitaciones.' },
    { key: '3', label: 'Devoluciones.' },
    { key: '4', label: 'Inconsistencias Grandes Contribuyentes.' },
  ];
  const label = (o: { label: string }) => o.label;

  it('encuentra la opción exacta sin importar el punto final', () => {
    expect(findBestMatch(options, 'Devoluciones', label)?.key).toBe('3');
    expect(findBestMatch(options, 'devoluciones.', label)?.key).toBe('3');
  });

  it('acepta la coincidencia por prefijo', () => {
    expect(findBestMatch(options, 'RUT y orientación', label)?.key).toBe('1');
  });

  it('acepta la coincidencia parcial como último recurso', () => {
    expect(findBestMatch(options, 'Grandes Contribuyentes', label)?.key).toBe('4');
  });

  it('prefiere la coincidencia exacta sobre la parcial', () => {
    const ambiguous = [
      { key: 'a', label: 'Cobranzas persona jurídica' },
      { key: 'b', label: 'Cobranzas' },
    ];
    expect(findBestMatch(ambiguous, 'Cobranzas', label)?.key).toBe('b');
  });

  it('devuelve undefined cuando no hay nada parecido', () => {
    expect(findBestMatch(options, 'Pasaportes', label)).toBeUndefined();
    expect(findBestMatch(options, '', label)).toBeUndefined();
  });
});
