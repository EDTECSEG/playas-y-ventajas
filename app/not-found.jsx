import { theme } from '../lib/theme';

export default function NotFound() {
  const wrap = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: 8,
    padding: 24,
    color: theme.text,
    background: theme.bg,
    textAlign: 'center',
    fontFamily: 'system-ui, sans-serif',
  };
  return (
    <main style={wrap}>
      <p style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Página não encontrada</p>
      <p style={{ fontSize: 14, color: theme.textMuted, margin: 0, marginBottom: 16 }}>
        O endereço que você tentou acessar não existe ou foi movido.
      </p>
      <a
        href="/cliente"
        style={{
          padding: '10px 20px',
          borderRadius: 10,
          border: 'none',
          cursor: 'pointer',
          background: theme.gold,
          color: theme.greenDark,
          fontWeight: 700,
          textDecoration: 'none',
          fontSize: 14,
        }}
      >
        Ir para a página inicial
      </a>
    </main>
  );
}