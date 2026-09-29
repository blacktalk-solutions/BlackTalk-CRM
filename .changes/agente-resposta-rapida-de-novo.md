---
impacto: nada_mudou
secao: corrigido
titulo: Agente de atendimento volta a responder em segundos, não minutos
---

Achado validando em produção: retomar uma conversa às vezes levava minutos
para o agente responder — mais devagar que um atendente humano.

Causa raiz: dois dos handlers do processamento de evento (indexação de RAG e
exportação de dados de LGPD) puxam uma biblioteca de geração de PDF cuja
dependência interna falhava ao carregar dentro da imagem publicada. Como esse
import acontecia no topo do arquivo que registra TODOS os handlers — inclusive
o que dispara a resposta da IA a uma mensagem recebida —, a falha de um
derrubava o registro de todos, e o sistema caía para o caminho de segurança
mais lento (verificação a cada minuto, em vez de contínua).

Os dois handlers agora carregam essa dependência sob demanda, isolados um do
outro e do resto — uma falha ali some sem afetar a velocidade de resposta do
agente.
