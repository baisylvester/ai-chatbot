export default function EmailConfirmedPage() {
  return <main style={{maxWidth:480,margin:"80px auto",padding:24,fontFamily:"sans-serif"}}>
    <h1>Return to Mail Assistant</h1>
    <p>After confirming your email, return to the app and sign in to finish setting up your personal assistant.</p>
    <a href="chatbotmail://auth/email-confirmed">Open Mail Assistant</a>
  </main>;
}
